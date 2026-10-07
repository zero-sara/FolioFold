# -*- coding: utf-8 -*-
"""AI Project 信息结构 + Translation Review（2026-09-26）的词典补录。
把 T 表里的中文键与 9 语言译文写进 tools/i18n/zh.json（en 列）与 zh.<lang>.json。
幂等：直接按键覆盖，可重复跑。跑完需再跑 build_dict.py。
"""
import json, io, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LANGS = ['zh-TW', 'ja', 'ko', 'fr', 'es', 'it', 'de', 'pt']

AI_HINT = ('四个文字字段的分工：一句简介 = 项目是什么；项目定位 = 项目的定位与特点（项目层信息，不是个人定位）；'
           '我的角色 = 我在这个项目中担任的角色（短）；我的贡献 = 我实际完成、参与或负责的工作（正文）。'
           '个人角色由「我的角色」表达，具体行动和成果由「我的贡献」表达，不要在这四个之外再加第五个类似字段。'
           '其余字段：技术栈 / Highlights / GitHub / Live Demo / 封面 / 截图，保存后作品集与排版编辑同步生效。')
MODE_FRAG = ('按下面选的翻译质量模式跟随切换 —— 「发布前审核」模式下只有你确认过的译文才会正式显示，'
             '「机器翻译直接使用」模式下生成即可用。')
FLOW_HINT = ('流程（每个语言一行）：① 「将整篇翻译为…」用本地 Ollama 生成译文；② 「预览草稿」在新窗口检查（含未确认译文）；'
             '③ 「确认翻译」把该语言标记为可直接使用。状态一栏会如实显示：未生成 / 翻译草稿 · 待确认 / 已就绪 —— '
             '没有后台审核，一切由你在这里决定。原文修改后该语言会标「需要重新检查」，旧译文保留不删。'
             '生成过的译文在重新生成时会原样复用，已验收的内容不会因为重翻而变样。')
NO_SERVICE = '⚠ 当前没有探测到可用的翻译服务：已有译文照常显示，但无法生成新译文。语言入口仍保留（本机装了服务后会自动恢复）。'
VE_HINT = ('新增独立 AI 项目，与已有 AI Voices 卡片使用同一套模板：名称 / 简介可直接在画布上改；'
           '项目定位、我的角色、我的贡献、技术栈、亮点、GitHub 链接和多张截图请在「文本编辑 → AI Project」补充。')

# 每行：中文键, en, zh-TW, ja, ko, fr, es, it, de, pt
T = [
    ('项目定位', 'Positioning', '項目定位', '位置づけ', '포지셔닝', 'Positionnement',
     'Posicionamiento', 'Posizionamento', 'Positionierung', 'Posicionamento'),
    ('我的贡献', 'Contribution', '我的貢獻', '私の貢献', '내 기여', 'Ma contribution',
     'Mi contribución', 'Il mio contributo', 'Mein Beitrag', 'Minha contribuição'),
    (AI_HINT,
     'How the four text fields divide the work: Summary = what the project is; Positioning = the project’s positioning and characteristics (project-level info, not a personal positioning); My Role = the role you played in this project (short); Contribution = the work you actually completed, took part in, or owned (body text). Your personal role is expressed by “My Role”, concrete actions and results by “Contribution” — do not add a fifth similar field beyond these four. Other fields: tech stack / Highlights / GitHub / Live Demo / cover / screenshots; saving syncs the portfolio and the visual editor.',
     '四個文字欄位的分工：一句簡介 = 項目是什麼；項目定位 = 項目的定位與特點（項目層信息，不是個人定位）；我的角色 = 我在這個項目中擔任的角色（短）；我的貢獻 = 我實際完成、參與或負責的工作（正文）。個人角色由「我的角色」表達，具體行動和成果由「我的貢獻」表達，不要在這四個之外再加第五個類似欄位。其餘欄位：技術棧 / Highlights / GitHub / Live Demo / 封面 / 截圖，儲存後作品集與排版編輯同步生效。',
     '4つのテキスト欄の分担：要約 = このプロジェクトは何か。位置づけ = プロジェクトの位置づけと特徴（プロジェクト層の情報であり、個人のポジショニングではない）。私の役割 = このプロジェクトで担った役割（短め）。私の貢献 = 実際に完成・参加・担当した作業（本文）。個人の役割は「私の役割」が、具体的な行動と成果は「私の貢献」が担います。この4つ以外に類似した欄を追加しないでください。その他の欄：技術スタック / ハイライト / GitHub / Live Demo / カバー / スクリーンショット。保存するとポートフォリオとビジュアルエディターに同期します。',
     '네 텍스트 필드의 역할 분담: 한 줄 소개 = 이 프로젝트가 무엇인지. 포지셔닝 = 프로젝트의 위치와 특징(프로젝트 수준 정보이지 개인 포지셔닝이 아님). 내 역할 = 이 프로젝트에서 맡은 역할(짧게). 내 기여 = 실제로 완성·참여·담당한 작업(본문). 개인 역할은 "내 역할"이, 구체적 행동과 성과는 "내 기여"가 표현합니다. 이 네 가지 외에 유사한 필드를 더 추가하지 마세요. 나머지 필드: 기술 스택 / 하이라이트 / GitHub / Live Demo / 커버 / 스크린샷. 저장하면 포트폴리오와 비주얼 편집기에 동기화됩니다.',
     'Répartition des quatre champs de texte : Résumé = ce qu’est le projet ; Positionnement = le positionnement et les caractéristiques du projet (information au niveau du projet, pas un positionnement personnel) ; Mon rôle = le rôle que vous avez joué dans ce projet (court) ; Ma contribution = le travail que vous avez réellement réalisé, rejoint ou pris en charge (corps de texte). Le rôle personnel est exprimé par « Mon rôle », les actions et résultats concrets par « Ma contribution » — n’ajoutez pas de cinquième champ similaire. Autres champs : stack technique / Points forts / GitHub / Live Demo / couverture / captures d’écran ; l’enregistrement synchronise le portfolio et l’éditeur visuel.',
     'Reparto de los cuatro campos de texto: Resumen = qué es el proyecto; Posicionamiento = el posicionamiento y las características del proyecto (información a nivel de proyecto, no un posicionamiento personal); Mi rol = el papel que desempeñaste en este proyecto (corto); Mi contribución = el trabajo que realmente completaste, en el que participaste o del que te encargaste (cuerpo de texto). El papel personal lo expresa «Mi rol», y las acciones y resultados concretos «Mi contribución»: no añadas un quinto campo similar. Otros campos: stack técnico / Aspectos destacados / GitHub / Live Demo / portada / capturas de pantalla; al guardar se sincronizan el portafolio y el editor visual.',
     'Ripartizione dei quattro campi di testo: Riassunto = cos’è il progetto; Posizionamento = il posizionamento e le caratteristiche del progetto (informazione a livello di progetto, non un posizionamento personale); Il mio ruolo = il ruolo che hai svolto in questo progetto (breve); Il mio contributo = il lavoro che hai effettivamente completato, a cui hai partecipato o di cui ti sei occupato (corpo del testo). Il ruolo personale è espresso da «Il mio ruolo», le azioni e i risultati concreti da «Il mio contributo»: non aggiungere un quinto campo simile. Altri campi: stack tecnologico / In evidenza / GitHub / Live Demo / copertina / screenshot; il salvataggio sincronizza portfolio ed editor visivo.',
     'Aufteilung der vier Textfelder: Kurzeinführung = was das Projekt ist; Positionierung = Positionierung und Besonderheiten des Projekts (Information auf Projektebene, keine persönliche Positionierung); Meine Rolle = die Rolle, die du in diesem Projekt innehatest (kurz); Mein Beitrag = die Arbeit, die du tatsächlich abgeschlossen, mitgestaltet oder verantwortet hast (Fließtext). Die persönliche Rolle drückt „Meine Rolle“ aus, konkrete Handlungen und Ergebnisse „Mein Beitrag“ – füge kein fünftes ähnliches Feld hinzu. Weitere Felder: Tech-Stack / Highlights / GitHub / Live Demo / Cover / Screenshots; beim Speichern werden Portfolio und visueller Editor synchronisiert.',
     'Divisão dos quatro campos de texto: Resumo = o que é o projeto; Posicionamento = o posicionamento e as características do projeto (informação no nível do projeto, não um posicionamento pessoal); Meu papel = o papel que você desempenhou neste projeto (curto); Minha contribuição = o trabalho que você de fato concluiu, participou ou ficou responsável (corpo de texto). O papel pessoal é expresso por “Meu papel”, e as ações e resultados concretos por “Minha contribuição”: não adicione um quinto campo semelhante. Outros campos: stack técnica / Destaques / GitHub / Live Demo / capa / capturas de tela; ao salvar, o portfólio e o editor visual ficam sincronizados.'),
    (MODE_FRAG,
     'follow the translation quality mode selected below — in “Review before publishing” mode only translations you have confirmed are shown officially; in “Use machine translation directly” mode they are usable as soon as generated.',
     '依下面選的翻譯品質模式跟隨切換 —— 「發布前確認」模式下只有你確認過的譯文才會正式顯示，「機器翻譯直接使用」模式下產生即可用。',
     '下で選んだ翻訳品質モードに従って切り替わります —— 「公開前に確認」モードでは確認済みの訳のみ正式表示され、「機械翻訳をそのまま使用」モードでは生成後すぐ使えます。',
     '아래에서 선택한 번역 품질 모드를 따릅니다 —— "게시 전 확인" 모드에서는 확인한 번역만 정식 표시되고, "기계 번역 바로 사용" 모드에서는 생성 즉시 사용할 수 있습니다.',
     'suit le mode de qualité de traduction choisi ci-dessous — en mode « Vérifier avant publication », seules les traductions confirmées sont affichées officiellement ; en mode « Traduction automatique directe », elles sont utilisables dès leur génération.',
     'sigue el modo de calidad de traducción elegido abajo — en el modo «Revisar antes de publicar» solo se muestran oficialmente las traducciones confirmadas; en «Usar traducción automática directamente» se pueden usar nada más generarse.',
     'segue la modalità di qualità della traduzione scelta qui sotto — in modalità «Verifica prima della pubblicazione» vengono mostrate ufficialmente solo le traduzioni confermate; in «Usa direttamente la traduzione automatica» sono utilizzabili appena generate.',
     'folgt dem unten gewählten Übersetzungsqualitätsmodus — im Modus „Vor Veröffentlichung prüfen“ werden nur bestätigte Übersetzungen offiziell angezeigt; im Modus „Maschinenübersetzung direkt verwenden“ sind sie sofort nach der Erstellung nutzbar.',
     'segue o modo de qualidade da tradução escolhido abaixo — no modo “Revisar antes de publicar”, só as traduções confirmadas são exibidas oficialmente; em “Usar tradução automática diretamente”, podem ser usadas assim que geradas.'),
    (FLOW_HINT,
     'Workflow (one row per language): 1. “Translate everything to…” generates translations with local Ollama; 2. “Preview draft” opens a new window to check them (including unconfirmed ones); 3. “Approve translation” marks the language as ready to use. The status column tells the truth: Not generated / Draft · awaiting confirmation / Ready — there is no back-office review; everything is decided here. When you edit the original text, the language is marked “Needs re-check”; old translations are kept, never deleted. Regenerating reuses existing translations, so accepted content never changes behind your back.',
     '流程（每個語言一行）：① 「將整篇翻譯為…」用本地 Ollama 產生譯文；② 「預覽草稿」在新視窗檢查（含未確認譯文）；③ 「確認翻譯」把該語言標記為可直接使用。狀態一欄會如實顯示：未生成 / 翻譯草稿 · 待確認 / 已就緒 —— 沒有後台審核，一切由你在這裡決定。原文修改後該語言會標「需要重新檢查」，舊譯文保留不刪。產生過的譯文在重新產生時會原樣複用，已驗收的內容不會因為重翻而變樣。',
     '流れ（言語ごとに1行）：① 「すべて翻訳…」でローカル Ollama が訳文を生成。② 「ドラフトをプレビュー」で新しいウィンドウ確認（未確認の訳を含む）。③ 「翻訳を確認」でその言語を使用可能としてマーク。状態欄はありのまま表示：未生成 / 翻訳ドラフト · 確認待ち / 準備完了 —— バックグラウンドの審査はなく、すべてここで決めます。原文を変更すると「要再確認」が付きますが、古い訳は削除されません。生成済みの訳は再生成時にそのまま再利用され、確認済みの内容が勝手に変わることはありません。',
     '흐름(언어별 한 줄): ① "전체 번역…"으로 로컬 Ollama가 번역을 생성합니다. ② "초안 미리 보기"로 새 창에서 확인(미확인 번역 포함). ③ "번역 확인"으로 해당 언어를 사용 가능으로 표시합니다. 상태 열은 있는 그대로 보여 줍니다: 미생성 / 번역 초안 · 확인 대기 / 준비됨 —— 백그라운드 검토는 없으며 모두 여기서 결정합니다. 원문을 수정하면 "다시 확인 필요"가 표시되지만 기존 번역은 삭제되지 않습니다. 생성된 번역은 재생성 시 그대로 재사용되어 이미 확인한 내용이 몰래 바뀌지 않습니다.',
     'Déroulé (une ligne par langue) : ① « Tout traduire vers… » génère les traductions avec l’Ollama local ; ② « Prévisualiser le brouillon » ouvre une fenêtre pour vérifier (y compris les non-confirmées) ; ③ « Approuver la traduction » marque la langue comme prête à l’emploi. La colonne de statut dit la vérité : Non générée / Brouillon · à confirmer / Prête — aucune validation en coulisses, tout se décide ici. Si vous modifiez le texte original, la langue est marquée « À revérifier » ; les anciennes traductions sont conservées, jamais supprimées. Une régénération réutilise les traductions existantes : le contenu déjà validé ne change pas en secret.',
     'Flujo (una fila por idioma): ① «Traducir todo a…» genera las traducciones con Ollama local; ② «Previsualizar borrador» abre una ventana para revisarlas (incluidas las no confirmadas); ③ «Aprobar traducción» marca el idioma como listo para usar. La columna de estado dice la verdad: Sin generar / Borrador · pendiente de confirmar / Lista — no hay revisión en segundo plano; todo se decide aquí. Si modificas el texto original, el idioma se marca «Necesita revisarse»; las traducciones antiguas se conservan, nunca se borran. Al regenerar se reutilizan las traducciones existentes: el contenido ya confirmado no cambia a tus espaldas.',
     'Flusso (una riga per lingua): ① «Traduci tutto in…» genera le traduzioni con Ollama locale; ② «Anteprima bozza» apre una finestra per verificarle (comprese quelle non confermate); ③ «Approva traduzione» contrassegna la lingua come pronta all’uso. La colonna di stato dice la verità: Non generata / Bozza · da confermare / Pronta — nessuna revisione in background, tutto si decide qui. Se modifichi il testo originale, la lingua viene contrassegnata «Da riverificare»; le vecchie traduzioni sono conservate, mai eliminate. La rigenerazione riutilizza le traduzioni esistenti: i contenuti già confermati non cambiano alle tue spalle.',
     'Ablauf (eine Zeile pro Sprache): ① „Alles übersetzen nach …“ erzeugt die Übersetzungen mit lokalem Ollama; ② „Entwurf ansehen“ öffnet ein Fenster zur Prüfung (einschließlich unbestätigter); ③ „Übersetzung bestätigen“ markiert die Sprache als einsatzbereit. Die Statusspalte sagt die Wahrheit: Nicht erstellt / Entwurf · Bestätigung ausstehend / Bereit — es gibt keine Prüfung im Hintergrund; alles entscheidest du hier. Wenn du den Originaltext änderst, wird die Sprache mit „Erneut prüfen“ markiert; alte Übersetzungen bleiben erhalten, werden nie gelöscht. Eine Neuerstellung wiederverwendet vorhandene Übersetzungen: bereits bestätigte Inhalte ändern sich nicht heimlich.',
     'Fluxo (uma linha por idioma): ① “Traduzir tudo para…” gera as traduções com o Ollama local; ② “Pré-visualizar rascunho” abre uma janela para conferir (incluindo as não confirmadas); ③ “Aprovar tradução” marca o idioma como pronto para uso. A coluna de status diz a verdade: Não gerada / Rascunho · aguardando confirmação / Pronta — não há revisão em segundo plano; tudo é decidido aqui. Se você editar o texto original, o idioma é marcado como “Precisa ser reverificado”; traduções antigas são mantidas, nunca apagadas. A regeneração reutiliza as traduções existentes: o conteúdo já confirmado não muda às escondidas.'),
    (NO_SERVICE,
     '⚠ No usable translation service detected: existing translations still display, but new ones cannot be generated. Language entries remain (they will come back automatically once the service is installed).',
     '⚠ 目前沒有探測到可用的翻譯服務：已有譯文照常顯示，但無法產生新譯文。語言入口仍保留（本機裝了服務後會自動恢復）。',
     '⚠ 使用可能な翻訳サービスが検出されていません：既存の訳はそのまま表示されますが、新しい訳は生成できません。言語入口は残ります（サービスを導入すると自動的に戻ります）。',
     '⚠ 사용 가능한 번역 서비스가 감지되지 않았습니다: 기존 번역은 그대로 표시되지만 새 번역은 생성할 수 없습니다. 언어 입구는 유지됩니다(서비스 설치 후 자동 복구).',
     '⚠ Aucun service de traduction utilisable détecté : les traductions existantes s’affichent normalement, mais il est impossible d’en générer de nouvelles. Les entrées de langue restent (elles reviendront automatiquement une fois le service installé).',
     '⚠ No se ha detectado un servicio de traducción utilizable: las traducciones existentes se muestran con normalidad, pero no se pueden generar nuevas. Las entradas de idioma permanecen (volverán automáticamente cuando instales el servicio).',
     '⚠ Nessun servizio di traduzione utilizzabile rilevato: le traduzioni esistenti vengono mostrate normalmente, ma non è possibile generarne di nuove. Le voci di lingua restano (torneranno automaticamente una volta installato il servizio).',
     '⚠ Kein nutzbarer Übersetzungsdienst erkannt: vorhandene Übersetzungen werden weiterhin angezeigt, neue können jedoch nicht erzeugt werden. Die Spracheinträge bleiben (sie kommen automatisch zurück, sobald der Dienst installiert ist).',
     '⚠ Nenhum serviço de tradução utilizável detectado: as traduções existentes continuam sendo exibidas, mas novas não podem ser geradas. As entradas de idioma permanecem (voltam automaticamente quando o serviço for instalado).'),
    (VE_HINT,
     'Adds a standalone AI project using the same template as the existing AI Voices cards: name / summary can be edited directly on the canvas; positioning, my role, contribution, tech stack, highlights, the GitHub link and screenshots are filled in under Text Editor → AI Project.',
     '新增獨立 AI 項目，與已有 AI Voices 卡片使用同一套模板：名稱 / 簡介可直接在畫布上改；項目定位、我的角色、我的貢獻、技術棧、亮點、GitHub 連結和多張截圖請在「文本編輯 → AI Project」補充。',
     '独立した AI プロジェクトを追加します。既存の AI Voices カードと同じテンプレートを使います：名前 / 要約はキャンバス上で直接編集でき、位置づけ・私の役割・私の貢献・技術スタック・ハイライト・GitHub リンク・複数スクリーンショットは「テキストエディター → AI Project」で入力します。',
     '독립적인 AI 프로젝트를 추가합니다. 기존 AI Voices 카드와 같은 템플릿을 사용합니다: 이름 / 소개는 캔버스에서 바로 수정하고, 포지셔닝·내 역할·내 기여·기술 스택·하이라이트·GitHub 링크·스크린샷은 "텍스트 편집기 → AI Project"에서 입력하세요.',
     'Ajoute un projet IA autonome avec le même modèle que les cartes AI Voices existantes : nom / résumé modifiables directement sur le canevas ; positionnement, mon rôle, ma contribution, stack technique, points forts, lien GitHub et captures d’écran se remplissent dans Éditeur de texte → AI Project.',
     'Añade un proyecto de IA independiente con la misma plantilla que las tarjetas AI Voices existentes: nombre / resumen se editan directamente en el lienzo; posicionamiento, mi rol, mi contribución, stack técnico, aspectos destacados, enlace de GitHub y capturas se completan en Editor de texto → AI Project.',
     'Aggiunge un progetto AI autonomo con lo stesso modello delle schede AI Voices esistenti: nome / riassunto modificabili direttamente sulla tela; posizionamento, il mio ruolo, il mio contributo, stack tecnologico, in evidenza, link GitHub e screenshot si compilano in Editor di testo → AI Project.',
     'Fügt ein eigenständiges KI-Projekt hinzu, mit derselben Vorlage wie die bestehenden AI-Voices-Karten: Name / Kurzeinführung direkt auf der Leinwand änderbar; Positionierung, Meine Rolle, Mein Beitrag, Tech-Stack, Highlights, GitHub-Link und Screenshots unter Texteditor → AI Project ergänzen.',
     'Adiciona um projeto de IA independente com o mesmo modelo dos cartões AI Voices existentes: nome / resumo podem ser editados direto na tela; posicionamento, meu papel, minha contribuição, stack técnica, destaques, link do GitHub e capturas de tela ficam em Editor de texto → AI Project.'),
]


def main():
    n = 0
    for row in T:
        key, en = row[0], row[1]
        outs = row[2:]
        assert len(outs) == len(LANGS), key
        zh_path = os.path.join(ROOT, 'tools', 'i18n', 'zh.json')
        zh = json.load(io.open(zh_path, encoding='utf-8'))
        zh[key] = en
        io.open(zh_path, 'w', encoding='utf-8', newline='\n').write(
            json.dumps(zh, ensure_ascii=False, indent=1) + '\n')
        for lang, val in zip(LANGS, outs):
            lp = os.path.join(ROOT, 'tools', 'i18n', 'zh.%s.json' % lang)
            d = json.load(io.open(lp, encoding='utf-8'))
            d[key] = val
            io.open(lp, 'w', encoding='utf-8', newline='\n').write(
                json.dumps(d, ensure_ascii=False, indent=1) + '\n')
        n += 1
    print('dict +', n)


if __name__ == '__main__':
    main()
