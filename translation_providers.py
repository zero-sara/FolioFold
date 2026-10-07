"""Translation Provider boundary for FolioFold.

This module deliberately contains no network adapter.  It only exposes a
stable contract and the local configuration state required before a provider
can be enabled.  Translation remains separate from AI Organizer.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass
import json
from pathlib import Path
import urllib.error
import urllib.request


UNCONFIGURED_MESSAGE = '尚未配置翻译服务'
KNOWN_PROVIDERS = {'none', 'ollama', 'openai', 'deepl', 'tencent', 'azure'}
PROVIDER_LABELS = {
    'ollama': 'Ollama', 'openai': 'OpenAI', 'deepl': 'DeepL',
    'tencent': '腾讯云翻译', 'azure': 'Azure Translator',
}

# —— 强约束输出结构 ——
# 用 JSON Schema（而不是 format:'json'）把模型锁死在 {"translation": "..."}。
# 实测：format:'json' 时 qwen3:4b 会在 JSON 里写推理过程，耗时 ~51s；
# 换成 schema 后既快（7~11s）又稳定拿到目标字段。
TRANSLATION_JSON_SCHEMA = {
    'type': 'object',
    'properties': {'translation': {'type': 'string'}},
    'required': ['translation'],
    'additionalProperties': False,
}

# —— 整篇翻译（批量）——
# 用户诉求：「我希望它的整体翻译是针对于作品集已经写的内容，然后直接就整体翻译，
# 不要再说文本编辑里一个去调，因为这样子的话很费时间」。
# 所以除逐条 Draft 之外，再加一条批量通道：一次把整份作品集的用户文案交给模型，
# 返回同长度的数组。用数组（按输入顺序）而不是对象（按原文当 key），
# 因为原文里可能有重复/换行，当 key 容易对不上；长度不一致时调用方会退回逐条翻。
BATCH_JSON_SCHEMA = {
    'type': 'object',
    'properties': {'translations': {'type': 'array', 'items': {'type': 'string'}}},
    'required': ['translations'],
    'additionalProperties': False,
}

# 目标语言 → 给模型看的语言名。只支持这几种（界面语言注册表同源）。
TARGET_LANGUAGE_NAMES = {
    'en': 'English', 'zh-TW': 'Traditional Chinese (Taiwan-style, convert simplified Chinese)',
    'ja': 'Japanese', 'ko': 'Korean',
    'fr': 'French', 'es': 'Spanish', 'it': 'Italian', 'de': 'German', 'pt': 'Portuguese',
}

# —— 术语保护表（用户可覆盖）——
# 用户诉求原话：「像有一些编程类的这一个专业名称比如说 Python，比如说 C 加加，
# 那这个它就是一个特定的英文，那这时候我觉得也就是要保留」。
# 规则分两类：
#   keep      = 必须原样保留、绝不能被翻译或"中文化"的词
#   preferred = 有官方/约定中文名的专名 → 给出标准英文写法
DEFAULT_GLOSSARY = {
    'keep': [
        'Python', 'C++', 'C#', 'JavaScript', 'TypeScript', 'Java', 'Go', 'Rust',
        'MATLAB', 'Max/MSP', 'Pure Data', 'SuperCollider', 'Reaper', 'Pro Tools',
        'Logic Pro', 'Ableton Live', 'Nuendo', 'Cubase', 'PyTorch', 'TensorFlow',
        'Ollama', 'Docker', 'Git', 'GitHub', 'Linux', 'macOS', 'Windows', 'FolioFold',
        'Dolby Atmos', '5.1', '7.1', 'Wwise', 'FMOD', 'Unreal Engine', 'Unity',
        'Ambisonics', 'ORTF', 'M/S', 'AES', 'SMPTE',
    ],
    'preferred': {
        # 作品名：有官方英文名的，英文模式用官方名
        '流浪地球': 'The Wandering Earth',
        '流浪地球2': 'The Wandering Earth II',
        '哪吒之魔童降世': 'Ne Zha',
        '大鱼海棠': 'Big Fish & Begonia',
        '让子弹飞': 'Let the Bullets Fly',
        '刺客聂隐娘': 'The Assassin',
        '地球最后的夜晚': 'Long Day\u2019s Journey into Night',
        '药神': 'Dying to Survive',
        '我不是药神': 'Dying to Survive',
    },
}


def _load_glossary(config_dir):
    """读取用户可编辑的术语表；文件不存在时用内置默认值。

    文件位置：<config_dir>/translation-glossary.json
    结构：{"keep": ["Python", ...], "preferred": {"中文名": "Official English Name"}}
    """
    path = Path(config_dir) / 'translation-glossary.json'
    keep = list(DEFAULT_GLOSSARY['keep'])
    preferred = dict(DEFAULT_GLOSSARY['preferred'])
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError):
        raw = None
    if isinstance(raw, dict):
        extra_keep = raw.get('keep')
        if isinstance(extra_keep, list):
            for x in extra_keep:
                if isinstance(x, str) and x.strip() and x.strip() not in keep:
                    keep.append(x.strip())
        extra_pref = raw.get('preferred')
        if isinstance(extra_pref, dict):
            for k, v in extra_pref.items():
                if isinstance(k, str) and isinstance(v, str) and k.strip() and v.strip():
                    preferred[k.strip()] = v.strip()
    return {'keep': keep, 'preferred': preferred}


def _glossary_prompt(glossary):
    """把术语表转成给模型看的硬约束段落。"""
    keep = glossary.get('keep') or []
    preferred = glossary.get('preferred') or {}
    lines = []
    if keep:
        lines.append('Do NOT translate, translate-away or localize these terms; keep them exactly as written: '
                     + ', '.join(keep) + '.')
    if preferred:
        pairs = '; '.join('%s => %s' % (k, v) for k, v in preferred.items())
        lines.append('For these proper nouns use exactly the given English name: ' + pairs + '.')
    # 作品名规则：影视作品名往往「中文名 + 官方英文名」并存，机器硬翻会毁掉它。
    # 因此默认原样保留中文名，只有术语表明确给了官方英文名时才替换。
    lines.append('Titles of works appearing inside the brackets \u300a\u300b must be copied exactly as in '
                 'the source (keep the Chinese title, and keep the \u300a\u300b brackets). Only replace such a '
                 'title when the glossary above explicitly maps it to an official English name.')
    lines.append('Never invent facts. Keep the sentence meaning identical to the source.')
    return '\n'.join(lines)


def preserve_terms(source, translation, glossary):
    """返回 (translation, report)。

    轻量后置校验：术语表里的 keep 词若在原文出现、却在新译文里消失，
    则认为模型把它翻掉了 —— 报告出来（不强行改文本，避免误伤），
    让审核者一眼看到风险点。这对应「术语要贴合、不要花里胡哨」的要求。
    """
    src = str(source or '')
    out = str(translation or '')
    lost = [w for w in (glossary.get('keep') or [])
            if w in src and w not in out]
    return out, {'preserved': len((glossary.get('keep') or [])) - len(lost), 'missing': lost}


# 小模型偶尔会把「/no_think」这类控制标记当成译文吐出来（实测：整批的**第 1 条**
# 最容易中招 —— 用户姓名被翻成 "no_think"）。这里做一道兜底：控制标记 / 空值 /
# 明显占位符一律当「没翻出来」处理（返回空串），调用方据此保留中文原文，
# 绝不把控制标记写进译文表。
_CONTROL_TOKENS = {'no_think', 'think', '/no_think', 'none', 'null', 'n/a', 'nan'}


def _sanitize_translation(value):
    text = str(value or '').strip()
    if not text:
        return ''
    if text.strip('/\\').strip().lower() in _CONTROL_TOKENS:
        return ''
    return text


# 4B 小模型对个别「复合专业词」会**原封不动留在中文里**（实测：入驻、同期录音，
# 同一条文案每次跑都可能中招，靠提示词约束不稳定）。这属于「漏翻」而非「风格差异」，
# 因此做一道**确定性兜底**：只有当译文里仍残留该中文词时才替换成标准英文写法。
# 只收高频、语义唯一、替换不会误伤的词；宁可少收，不要改坏译文。
_RESIDUAL_TERM_FIX = {
    'en': {
        '同期录音': 'sync recording',
        '数据标注': 'data annotation',
        '全景声': 'Dolby Atmos',
        '混音': 'mixing',
        '入驻': 'onboarding',
        '配音': 'voiceover',
    },
}


def _fix_residual_terms(text, target_language='en'):
    """把译文里残留的中文专业词替换成标准英文（按词长降序，避免嵌套误替换）。

    中英混排的边界要补空格：'new入驻' → 'new onboarding'，不能拼成 'newonboarding'。
    只跟**ASCII 字母数字**相邻时才补空格，避免在中文上下文里插出怪空格。
    """
    table = _RESIDUAL_TERM_FIX.get(str(target_language or 'en')) or {}
    out = str(text or '')
    for zh in sorted(table, key=len, reverse=True):
        en = table[zh]
        if zh not in out:
            continue
        pos = out.find(zh)
        while pos != -1:
            before = out[pos - 1] if pos > 0 else ''
            after = out[pos + len(zh)] if pos + len(zh) < len(out) else ''
            pre = ' ' if (before.isascii() and before.isalnum() and en[:1].isalpha()) else ''
            post = ' ' if (after.isascii() and after.isalnum() and en[-1:].isalpha()) else ''
            out = out[:pos] + pre + en + post + out[pos + len(zh):]
            pos = out.find(zh, pos + len(pre) + len(en) + len(post))
    return out


@dataclass(frozen=True)
class TranslationProviderStatus:
    provider: str
    state: str
    configured: bool
    supported: bool
    auto_upload: bool
    message: str
    code: str = ''

    def as_dict(self):
        return {
            'provider': self.provider,
            'state': self.state,
            'configured': self.configured,
            'supported': self.supported,
            'autoUpload': self.auto_upload,
            'message': self.message,
            'code': self.code,
        }


class TranslationProviderUnavailable(RuntimeError):
    def __init__(self, status):
        super().__init__(status.message)
        self.status = status


class TranslationProvider(ABC):
    """Future provider contract. Implementations must opt into source transfer."""

    @property
    @abstractmethod
    def provider_id(self):
        raise NotImplementedError

    @abstractmethod
    def status(self):
        raise NotImplementedError

    @abstractmethod
    def translate(self, request):
        """Return a provider result; never mutate FolioFold content directly."""
        raise NotImplementedError


@dataclass(frozen=True)
class TranslationRequest:
    source: str
    source_language: str = 'zh-CN'
    target_language: str = 'en'
    content_kind: str = 'project-summary'


def _local_ollama_url(value):
    value = str(value or 'http://127.0.0.1:11434').strip().rstrip('/')
    # Local-only is a deliberate privacy guard. This Phase does not allow a
    # configured endpoint to silently become a remote proxy.
    if not value.startswith(('http://127.0.0.1:', 'http://localhost:')):
        return ''
    return value


class OllamaTranslationProvider(TranslationProvider):
    def __init__(self, base_url, model, glossary=None):
        self.base_url = _local_ollama_url(base_url)
        self.model = str(model or '').strip()
        self.glossary = glossary or {'keep': [], 'preferred': {}}

    @property
    def provider_id(self):
        return 'ollama'

    def status(self):
        if not self.base_url or not self.model:
            return TranslationProviderStatus('ollama', 'unconfigured', False, True, False,
                '%s：请填写本机 Ollama 地址和模型名称' % UNCONFIGURED_MESSAGE,
                'translation_provider_unconfigured')
        try:
            with urllib.request.urlopen(self.base_url + '/api/tags', timeout=3) as response:
                payload = json.loads(response.read().decode('utf-8'))
            names = {str(x.get('name') or '') for x in (payload.get('models') or []) if isinstance(x, dict)}
            if self.model not in names:
                return TranslationProviderStatus('ollama', 'unconfigured', False, True, False,
                    '%s：本机尚未下载模型 %s' % (UNCONFIGURED_MESSAGE, self.model),
                    'translation_model_missing')
        except (OSError, ValueError, urllib.error.URLError):
            return TranslationProviderStatus('ollama', 'unconfigured', False, True, False,
                '%s：Ollama 本地服务未运行' % UNCONFIGURED_MESSAGE,
                'translation_provider_unavailable')
        return TranslationProviderStatus('ollama', 'ready', True, True, False,
            'Ollama 本地翻译服务已就绪', 'translation_provider_ready')

    def translate(self, request):
        state = self.status()
        if not state.configured:
            raise TranslationProviderUnavailable(state)
        system = (
            'You are a professional Chinese-to-English translator working on a film-sound '
            'portfolio / r\u00e9sum\u00e9. Write natural, professional, concise English suitable for '
            'a job application. Prefer the established industry term over a literal gloss. '
            'A Chinese personal name must be transliterated into Hanyu Pinyin (e.g. \u5f20\u4e09 \u2192 '
            'Zhang San), never translated by the meaning of its characters; never translate a '
            'brand or product name (FolioFold stays FolioFold). '
            'Do not embellish and never add achievements, tools or responsibilities that are '
            'not present in the source.\n' + _glossary_prompt(self.glossary) + '\n'
            'Reply with JSON only, exactly: {"translation": "<English text>"}.'
        )
        user = (
            'Translate the following Chinese text into English. '
            'Output the translation only, inside the JSON object.\n\n'
            'Chinese:\n' + request.source
        )
        body = json.dumps({
            'model': self.model, 'stream': False, 'think': False,
            'format': TRANSLATION_JSON_SCHEMA,
            'keep_alive': '10m',
            'messages': [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': user},
            ],
            'options': {'temperature': 0.15, 'num_predict': 512},
        }, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(self.base_url + '/api/chat', data=body,
            headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=300) as response:
                payload = json.loads(response.read().decode('utf-8'))
            content = ((payload.get('message') or {}).get('content') or '').strip()
            result = json.loads(content)
            translation = _sanitize_translation(result.get('translation') if isinstance(result, dict) else '')
            if not translation:
                raise ValueError('模型没有返回可用英文内容')
            cleaned, _report = preserve_terms(request.source, translation, self.glossary)
            return _fix_residual_terms(cleaned, request.target_language)
        except TranslationProviderUnavailable:
            raise
        except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
            failed = TranslationProviderStatus('ollama', 'failed', True, True, False,
                'Ollama 翻译失败：%s' % str(error)[:160], 'translation_provider_failed')
            raise TranslationProviderUnavailable(failed)

    def translate_batch(self, strings, target_language='en'):
        """一次翻多条用户文案（整篇翻译用）。返回与输入等长的列表。

        对齐策略：给模型编号输入、要求返回**同长度的数组**。长度对不上就抛异常，
        由调用方退回逐条翻译 —— 宁可慢一点，也不要把译文错位贴到别的字段上
        （错位比漏翻严重得多：用户会看到"教育经历"里写着别人的项目描述）。
        """
        state = self.status()
        if not state.configured:
            raise TranslationProviderUnavailable(state)
        items = [str(s or '') for s in strings]
        if not items:
            return []
        lang_name = TARGET_LANGUAGE_NAMES.get(str(target_language or 'en'), 'English')
        system = (
            'You are a professional translator working on a film-sound portfolio / r\u00e9sum\u00e9. '
            'Translate each numbered Chinese string into %s. Keep proper nouns, product and '
            'software names as they are usually written in %s (e.g. Python, Pro Tools, Dolby Atmos, '
            'GitHub). A Chinese **personal name** must be transliterated into Hanyu Pinyin '
            '(e.g. \u5f20\u4e09 \u2192 Zhang San) — never translate a name by the meaning of its '
            'characters. Never translate a brand or product name (e.g. FolioFold stays FolioFold). '
            'Preserve line breaks inside a string. Never merge or split items, never add '
            'explanations, never leave an item untranslated, and never invent achievements that are '
            'not in the source. If an item is already in %s, return it unchanged.\n'
            'Reply with JSON only, exactly: {"translations": ["...", "..."]} — one element per input, '
            'in the same order.' % (lang_name, lang_name, lang_name)
        )
        numbered = '\n'.join('%d. %s' % (i + 1, s) for i, s in enumerate(items))
        user = (
            'Translate all %d strings into %s. Return the "translations" array with exactly %d elements.\n\n'
            '%s' % (len(items), lang_name, len(items), numbered)
        )
        body = json.dumps({
            'model': self.model, 'stream': False, 'think': False,
            'format': BATCH_JSON_SCHEMA,
            'keep_alive': '10m',
            'messages': [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': user},
            ],
            # 整批输出，长度随输入增长；num_predict 按输入规模放宽，避免被截断（截断=长度不符=白跑）。
            'options': {'temperature': 0.15, 'num_predict': max(512, 120 * len(items))},
        }, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(self.base_url + '/api/chat', data=body,
            headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=600) as response:
                payload = json.loads(response.read().decode('utf-8'))
            content = ((payload.get('message') or {}).get('content') or '').strip()
            result = json.loads(content)
            out = result.get('translations') if isinstance(result, dict) else None
            if not isinstance(out, list) or len(out) != len(items):
                raise ValueError('批量返回条数不符（期望 %d，收到 %s）'
                                 % (len(items), len(out) if isinstance(out, list) else '非数组'))
            cleaned = []
            for src, dst in zip(items, out):
                text = _sanitize_translation(dst if isinstance(dst, str) else '')
                if text:
                    text, _report = preserve_terms(src, text, self.glossary)
                    text = _fix_residual_terms(text, target_language)
                cleaned.append(text)
            return cleaned
        except TranslationProviderUnavailable:
            raise
        except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
            failed = TranslationProviderStatus('ollama', 'failed', True, True, False,
                'Ollama 批量翻译失败：%s' % str(error)[:160], 'translation_provider_failed')
            raise TranslationProviderUnavailable(failed)


class UnavailableTranslationProvider(TranslationProvider):
    def __init__(self, provider_id, code, message):
        self._provider_id = provider_id
        self._status = TranslationProviderStatus(
            provider=provider_id,
            state='unconfigured',
            configured=False,
            supported=False,
            auto_upload=False,
            message=message,
            code=code,
        )

    @property
    def provider_id(self):
        return self._provider_id

    def status(self):
        return self._status

    def translate(self, request):
        # A request is intentionally rejected before any source can leave the
        # server or be written into a Draft.
        raise TranslationProviderUnavailable(self._status)


def _read_config(config_dir):
    """Read optional local configuration without creating or modifying files."""
    path = Path(config_dir) / 'translation-provider.json'
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, TypeError):
        raw = {}
    return raw if isinstance(raw, dict) else {}


def resolve_translation_provider(config_dir):
    """Resolve selected local provider. Cloud adapters remain intentionally absent."""
    config = _read_config(config_dir)
    provider_id = str(config.get('provider') or 'none').strip().lower()
    if provider_id not in KNOWN_PROVIDERS:
        provider_id = 'none'
    if provider_id == 'none':
        return UnavailableTranslationProvider(
            'none', 'translation_provider_unconfigured', UNCONFIGURED_MESSAGE)
    if provider_id == 'ollama':
        providers = config.get('providers') if isinstance(config.get('providers'), dict) else {}
        options = providers.get('ollama') if isinstance(providers.get('ollama'), dict) else {}
        if options.get('enabled') is True:
            return OllamaTranslationProvider(options.get('baseUrl'), options.get('model'),
                                             _load_glossary(config_dir))
        return UnavailableTranslationProvider(
            'ollama', 'translation_provider_unconfigured',
            '%s：Ollama 尚未在本地配置' % UNCONFIGURED_MESSAGE)
    label = PROVIDER_LABELS.get(provider_id, provider_id)
    return UnavailableTranslationProvider(
        provider_id,
        'translation_provider_not_implemented',
        '%s：%s Provider 尚未接入' % (UNCONFIGURED_MESSAGE, label),
    )


def translation_provider_status(config_dir):
    return resolve_translation_provider(config_dir).status()
