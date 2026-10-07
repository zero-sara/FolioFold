# -*- coding: utf-8 -*-
"""Phase 3 i18n 补漏：编辑器压缩/错误页 UI 串 + Studio 发布失败卡两段长指导文本。
把 T 表里的中文键与 9 语言译文写进 tools/i18n/zh.json（en 列）与 zh.<lang>.json。
幂等：直接按键覆盖，可重复跑。跑完需再跑 build_dict.py。
"""
import json, io, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LANGS = ['zh-TW', 'ja', 'ko', 'fr', 'es', 'it', 'de', 'pt']
SRC_FILES = ['studio/studio.js', 'editor/editor-v3.js', 'editor/index.html',
             'visual-editor/visual-editor-fix.js', 'visual-editor/index.html']

# 每行：中文键, en, zh-TW, ja, ko, fr, es, it, de, pt
T = [
    # —— 视频压缩卡 ——
    ("⚠️ 这个视频",
     "⚠️ This video is ", "⚠️ 這個影片", "⚠️ この動画は", "⚠️ 이 영상은",
     "⚠️ Cette vidéo fait ", "⚠️ Este vídeo pesa ", "⚠️ Questo video pesa ", "⚠️ Dieses Video ist ", "⚠️ Este vídeo tem "),
    ("MB（或编码浏览器不支持），发布后 GitHub Pages 只能「下载」不能「在线播放」。",
     "MB (or its codec is not supported by browsers); after publishing, GitHub Pages can only offer it as a download, not play it inline.",
     "MB（或瀏覽器不支援的編碼），發布後 GitHub Pages 只能「下載」不能「線上播放」。",
     "MB（またはブラウザが対応していないコーデック）のため、公開後の GitHub Pages では「ダウンロード」のみでオンライン再生できません。",
     "MB(또는 브라우저가 지원하지 않는 코덱)이므로 게시 후 GitHub Pages에서는 '다운로드'만 가능하고 온라인 재생은 되지 않습니다.",
     "Mo (ou son encodage n'est pas pris en charge par les navigateurs) ; après publication, GitHub Pages ne permettra que de la télécharger, pas de la lire en ligne.",
     "MB (o su códec no es compatible con los navegadores); tras publicar, GitHub Pages solo permitirá descargarlo, no reproducirlo en línea.",
     "MB (o il codec non è supportato dai browser); dopo la pubblicazione GitHub Pages consentirà solo di scaricarlo, non di riprodurlo inline.",
     "MB (oder ihr Codec wird von Browsern nicht unterstützt); nach der Veröffentlichung bietet GitHub Pages sie nur zum Download an, nicht zur Inline-Wiedergabe.",
     "MB (ou o codec não é compatível com os navegadores); depois de publicar, o GitHub Pages só permitirá baixá-lo, não reproduzi-lo on-line."),
    ("MB）· 发布后浏览器可直接在线播放，原片已保留",
     "MB) · plays directly in the browser after publishing; the original file is kept",
     "MB）· 發布後瀏覽器可直接線上播放，原片已保留",
     "MB）· 公開後はブラウザで直接再生でき、オリジナルも残ります",
     "MB) · 게시 후 브라우저에서 바로 온라인 재생되며, 원본은 보존됩니다",
     "Mo) · lisible directement dans le navigateur après publication ; l'original est conservé",
     "MB) · se reproduce directamente en el navegador tras publicar; el original se conserva",
     "MB) · riproducibile direttamente nel browser dopo la pubblicazione; l'originale viene conservato",
     "MB) · wird nach der Veröffentlichung direkt im Browser wiedergegeben; das Original bleibt erhalten",
     "MB) · reproduz diretamente no navegador depois de publicar; o original é mantido"),
    ("MB）。",
     "MB).", "MB）。", "MB）。", "MB)입니다.",
     " Mo).", " MB).", " MB).", " MB).", " MB)."),
    ("③ 直接用它，不用再压一遍",
     "③ Use it directly — no need to compress again",
     "③ 直接用它，不用再壓一遍", "③ そのまま使えます。再圧縮は不要",
     "③ 그대로 사용하세요. 다시 압축할 필요 없습니다",
     "③ Utilisez-le directement — inutile de recompresser",
     "③ Úsalo directamente — no hace falta volver a comprimir",
     "③ Usalo direttamente — non serve ricomprimere",
     "③ Direkt verwenden — keine erneute Komprimierung nötig",
     "③ Use-o diretamente — não é preciso comprimir de novo"),
    ("⚠️ 本机还没有压缩组件（ffmpeg）。点下面按钮自动装好（约 30MB，只装一次）。",
     "⚠️ The compression component (ffmpeg) is not installed on this machine yet. Click the button below to install it automatically (about 30MB, one time only).",
     "⚠️ 本機還沒有壓縮元件（ffmpeg）。點下面按鈕自動裝好（約 30MB，只裝一次）。",
     "⚠️ このマシンには圧縮コンポーネント（ffmpeg）がまだ入っていません。下のボタンで自動インストールしてください（約 30MB・一度だけ）。",
     "⚠️ 이 컴퓨터에는 아직 압축 구성 요소(ffmpeg)가 없습니다. 아래 버튼을 눌러 자동 설치하세요(약 30MB, 한 번만).",
     "⚠️ Le composant de compression (ffmpeg) n'est pas encore installé sur cette machine. Cliquez sur le bouton ci-dessous pour l'installer automatiquement (environ 30 Mo, une seule fois).",
     "⚠️ El componente de compresión (ffmpeg) aún no está instalado en esta máquina. Haz clic en el botón de abajo para instalarlo automáticamente (unos 30 MB, solo una vez).",
     "⚠️ Il componente di compressione (ffmpeg) non è ancora installato su questa macchina. Fai clic sul pulsante qui sotto per installarlo automaticamente (circa 30 MB, una sola volta).",
     "⚠️ Die Kompressionskomponente (ffmpeg) ist auf diesem Rechner noch nicht installiert. Klicke auf die Schaltfläche unten, um sie automatisch zu installieren (ca. 30 MB, nur einmal).",
     "⚠️ O componente de compressão (ffmpeg) ainda não está instalado nesta máquina. Clique no botão abaixo para instalá-lo automaticamente (cerca de 30 MB, apenas uma vez)."),
    ("✓ 已压缩版本（",
     "✓ Compressed version (", "✓ 已壓縮版本（", "✓ 圧縮済みバージョン（",
     "✓ 압축된 버전(", "✓ Version compressée (", "✓ Versión comprimida (",
     "✓ Versione compressa (", "✓ Komprimierte Version (", "✓ Versão comprimida ("),
    ("。",
     ".", "。", "。", ".", " .", ".", ".", ".", "."),
    ("。没有就是服务没开 → 双击",
     ". If it is missing, the service is not running → double-click ",
     "。沒有就是服務沒開 → 雙擊", "。なければサービスが起動していません → ダブルクリック",
     ". 없으면 서비스가 꺼진 것입니다 → 더블클릭",
     ". Si elle est absente, le service n'est pas lancé → double-cliquez sur ",
     ". Si no está, el servicio no está iniciado → haz doble clic en ",
     ". Se manca, il servizio non è avviato → fai doppio clic su ",
     ". Wenn sie fehlt, läuft der Dienst nicht → doppelklicke auf ",
     ". Se não estiver, o serviço não está em execução → clique duas vezes em "),
    ("下载压缩组件",
     "Download compression component", "下載壓縮元件", "圧縮コンポーネントをダウンロード",
     "압축 구성 요소 다운로드", "Télécharger le composant de compression", "Descargar componente de compresión",
     "Scarica componente di compressione", "Kompressionskomponente herunterladen", "Baixar componente de compressão"),
    ("作为 Web Preview（原片保留）",
     " as Web Preview (original kept)", "作為 Web Preview（原片保留）", "を Web Preview に使用（オリジナルは残します）",
     "을(를) Web Preview로 사용(원본 보존)", " comme aperçu Web (original conservé)", " como vista previa web (original conservado)",
     " come anteprima web (originale conservato)", " als Web-Vorschau (Original bleibt erhalten)", " como prévia na web (original mantido)"),
    ("已选用",
     "Picked ", "已選用", "選択：", "선택됨: ", "Choisi : ", "Elegido: ", "Scelto: ", "Ausgewählt: ", "Escolhido: "),
    ("本机已经有一个压好的版本：",
     "This machine already has a compressed version: ", "本機已經有一個壓好的版本：",
     "このマシンにはすでに圧縮済みの版本があります：", "이 컴퓨터에 이미 압축된 버전이 있습니다: ",
     "Cette machine a déjà une version compressée : ", "Esta máquina ya tiene una versión comprimida: ",
     "Questa macchina ha già una versione compressa: ", "Auf diesem Rechner gibt es bereits eine komprimierte Version: ",
     "Esta máquina já tem uma versão comprimida: "),
    # —— 翻译状态 / 服务提示 ——
    ("原始中文已更新；保留旧英文内容仅供审核参考。",
     "The original Chinese has been updated; the old English content is kept for review reference only.",
     "原始中文已更新；保留舊英文內容僅供審核參考。",
     "元の中国語が更新されました。旧英文コンテンツは審査用参考としてのみ残しています。",
     "원본 중국어가 업데이트되었습니다. 이전 영문 콘텐츠는 검토용 참고로만 보존됩니다.",
     "Le chinois original a été mis à jour ; l'ancien contenu anglais est conservé uniquement pour référence de relecture.",
     "El chino original se ha actualizado; el contenido antiguo en inglés se conserva solo como referencia de revisión.",
     "Il cinese originale è stato aggiornato; il vecchio contenuto inglese è conservato solo come riferimento di revisione.",
     "Das ursprüngliche Chinesische wurde aktualisiert; der alte englische Inhalt bleibt nur als Review-Referenz erhalten.",
     "O chinês original foi atualizado; o conteúdo antigo em inglês é mantido apenas como referência de revisão."),
    ("原文已更新，英文 Draft 待复核",
     "Source updated; the English draft needs re-review", "原文已更新，英文 Draft 待複核",
     "原文が更新されました。英文ドラフトを再確認してください", "원문이 업데이트되었습니다. 영문 초안을 다시 검토하세요",
     "Source mise à jour ; le brouillon anglais doit être revu", "Fuente actualizada; el borrador en inglés debe revisarse de nuevo",
     "Sorgente aggiornata; la bozza inglese va riverificata", "Quelle aktualisiert; der englische Entwurf muss neu geprüft werden",
     "Fonte atualizada; o rascunho em inglês precisa de nova revisão"),
    ("尚未生成英文 Draft",
     "No English draft yet", "尚未產生英文 Draft", "英文ドラフトはまだ生成されていません",
     "영문 초안이 아직 생성되지 않았습니다", "Pas encore de brouillon anglais", "Aún no hay borrador en inglés",
     "Nessuna bozza inglese ancora", "Noch kein englischer Entwurf", "Ainda não há rascunho em inglês"),
    ("尚未生成英文 Draft。",
     "No English draft yet.", "尚未產生英文 Draft。", "英文ドラフトはまだ生成されていません。",
     "영문 초안이 아직 생성되지 않았습니다.", "Pas encore de brouillon anglais.", "Aún no hay borrador en inglés.",
     "Nessuna bozza inglese ancora.", "Noch kein englischer Entwurf.", "Ainda não há rascunho em inglês."),
    ("尚未配置翻译服务",
     "Translation service not configured yet", "尚未設定翻譯服務", "翻訳サービスが未設定です",
     "번역 서비스가 아직 설정되지 않았습니다", "Service de traduction non configuré", "Servicio de traducción sin configurar",
     "Servizio di traduzione non configurato", "Übersetzungsdienst noch nicht konfiguriert", "Serviço de tradução ainda não configurado"),
    ("翻译服务已就绪；点「生成英文 Draft」开始。",
     "Translation service ready; click \"Generate English draft\" to start.",
     "翻譯服務已就緒；點「產生英文 Draft」開始。", "翻訳サービスの準備ができました。「英文ドラフトを生成」から始めてください。",
     "번역 서비스가 준비되었습니다. '영문 초안 생성'을 눌러 시작하세요.",
     "Service de traduction prêt ; cliquez sur « Générer le brouillon anglais » pour commencer.",
     "Servicio de traducción listo; haz clic en \"Generar borrador en inglés\" para empezar.",
     "Servizio di traduzione pronto; fai clic su \"Genera bozza inglese\" per iniziare.",
     "Übersetzungsdienst bereit; klicke auf „Englischen Entwurf generieren“, um zu starten.",
     "Serviço de tradução pronto; clique em \"Gerar rascunho em inglês\" para começar."),
    ("翻译请求失败",
     "Translation request failed", "翻譯請求失敗", "翻訳リクエストが失敗しました",
     "번역 요청 실패", "Échec de la requête de traduction", "Error en la solicitud de traducción",
     "Richiesta di traduzione non riuscita", "Übersetzungsanfrage fehlgeschlagen", "Falha na solicitação de tradução"),
    ("英文内容已审核",
     "English content reviewed", "英文內容已審核", "英文コンテンツは審査済み",
     "영문 콘텐츠 검토 완료", "Contenu anglais validé", "Contenido en inglés revisado",
     "Contenuto inglese revisionato", "Englischer Inhalt geprüft", "Conteúdo em inglês revisado"),
    ("英文草稿待审核",
     "English draft pending review", "英文草稿待審核", "英文ドラフトは審査待ち",
     "영문 초안 검토 대기 중", "Brouillon anglais en attente de relecture", "Borrador en inglés pendiente de revisión",
     "Bozza inglese in attesa di revisione", "Englischer Entwurf wartet auf Prüfung", "Rascunho em inglês aguardando revisão"),
    # —— 编辑器错误页 / 加载失败指引 ——
    ("排版编辑 / 预览作品集",
     "Visual Editor / Preview portfolio", "排版編輯 / 預覽作品集", "ビジュアルエディター / ポートフォリオをプレビュー",
     "비주얼 에디터 / 포트폴리오 미리보기", "Éditeur visuel / Aperçu du portfolio", "Editor visual / Vista previa del portfolio",
     "Editor visuale / Anteprima portfolio", "Visueller Editor / Portfolio-Vorschau", "Editor visual / Prévia do portfólio"),
    ("数据没取回来",
     "Couldn't load the data", "資料沒取回來", "データを取得できませんでした",
     "데이터를 가져오지 못했습니다", "Impossible de charger les données", "No se pudieron cargar los datos",
     "Impossibile caricare i dati", "Daten konnten nicht geladen werden", "Não foi possível carregar os dados"),
    ("有个文件没加载成功",
     "A file failed to load", "有個檔案沒載入成功", "一部のファイルの読み込みに失敗しました",
     "일부 파일을 불러오지 못했습니다", "Un fichier n'a pas pu être chargé", "No se pudo cargar un archivo",
     "Un file non è stato caricato", "Eine Datei konnte nicht geladen werden", "Um arquivo não pôde ser carregado"),
    ("服务开着 → 按",
     "If the service is running → press ", "服務開著 → 按", "サービスが起動中なら → 押す：",
     "서비스가 실행 중이면 → 누르세요: ", "Si le service est lancé → appuyez sur ", "Si el servicio está iniciado → pulsa ",
     "Se il servizio è attivo → premi ", "Wenn der Dienst läuft → drücke ", "Se o serviço estiver em execução → pressione "),
    ("本地服务可能没在跑，或浏览器还在用旧缓存页面。\n（自检地址：http://localhost:3000/api/health）",
     "The local service may not be running, or the browser is showing a stale cached page.\n(Self-check URL: http://localhost:3000/api/health)",
     "本地服務可能沒在跑，或瀏覽器還在用舊快取頁面。\n（自我檢查網址：http://localhost:3000/api/health）",
     "ローカルサービスが起動していないか、ブラウザが古いキャッシュページを表示している可能性があります。\n（セルフチェックURL：http://localhost:3000/api/health）",
     "로컬 서비스가 실행되지 않았거나 브라우저가 오래된 캐시 페이지를 보여주고 있을 수 있습니다.\n(자가 점검 주소: http://localhost:3000/api/health)",
     "Le service local ne tourne peut-être pas, ou le navigateur affiche une page en cache périmée.\n(URL d'auto-contrôle : http://localhost:3000/api/health)",
     "Es posible que el servicio local no esté en ejecución o que el navegador muestre una página en caché obsoleta.\n(URL de autocomprobación: http://localhost:3000/api/health)",
     "Il servizio locale potrebbe non essere in esecuzione, oppure il browser mostra una pagina cache obsoleta.\n(URL di autodiagnostica: http://localhost:3000/api/health)",
     "Der lokale Dienst läuft möglicherweise nicht, oder der Browser zeigt eine veraltete gecachte Seite.\n(Selbsttest-URL: http://localhost:3000/api/health)",
     "O serviço local pode não estar em execução, ou o navegador está mostrando uma página em cache desatualizada.\n(URL de autoverificação: http://localhost:3000/api/health)"),
    ("正在加载 FolioFold Editor…",
     "Loading FolioFold Editor…", "正在載入 FolioFold Editor…", "FolioFold Editor を読み込み中…",
     "FolioFold Editor 로드 중…", "Chargement de FolioFold Editor…", "Cargando FolioFold Editor…",
     "Caricamento di FolioFold Editor…", "FolioFold Editor wird geladen…", "Carregando FolioFold Editor…"),
    ("看一眼有没有一个黑色命令行窗口标题写着",
     "Check whether there is a black console window titled ", "看一眼有沒有一個黑色命令列視窗標題寫著",
     "タイトルが次の通りの黒いコマンドラインウィンドウがあるか確認してください：", "제목이 다음과 같은 검은 명령줄 창이 있는지 확인하세요: ",
     "Vérifiez s'il existe une fenêtre de console noire intitulée ", "Comprueba si hay una ventana de consola negra titulada ",
     "Verifica se c'è una finestra della console nera titolata ", "Prüfe, ob ein schwarzes Konsolenfenster mit dem Titel existiert ",
     "Verifique se há uma janela de console preta intitulada "),
    ("等了 10 秒还没加载完",
     "Still not loaded after 10 seconds", "等了 10 秒還沒載入完", "10秒待っても読み込みが完了しません",
     "10초를 기다려도 로드되지 않았습니다", "Toujours pas chargé après 10 secondes", "Sigue sin cargar tras 10 segundos",
     "Non ancora caricato dopo 10 secondi", "Nach 10 Sekunden immer noch nicht geladen", "Ainda não carregou após 10 segundos"),
    ("请按顺序试这三步（90% 的情况第 1 步就好）：",
     "Try these three steps in order (step 1 fixes it 90% of the time):",
     "請按順序試這三步（90% 的情況第 1 步就好）：", "次の 3 つを順に試してください（90% は第 1 步で解決します）：",
     "다음 세 가지를 순서대로 시도하세요(90%는 1번으로 해결됩니다): ",
     "Essayez ces trois étapes dans l'ordre (l'étape 1 suffit dans 90 % des cas) : ",
     "Prueba estos tres pasos en orden (el paso 1 lo resuelve el 90 % de las veces): ",
     "Prova questi tre passaggi in ordine (il passaggio 1 risolve nel 90% dei casi): ",
     "Probiere diese drei Schritte der Reihe nach (Schritt 1 löst es in 90 % der Fälle): ",
     "Experimente estes três passos em ordem (o passo 1 resolve em 90% dos casos): "),
    ("请求失败",
     "Request failed", "請求失敗", "リクエストが失敗しました", "요청 실패",
     "Échec de la requête", "Error en la solicitud", "Richiesta non riuscita", "Anfrage fehlgeschlagen", "Falha na solicitação"),
    ("超过单文件上限",
     "Exceeds the per-file size limit", "超過單檔案上限", "単一ファイルの上限を超えています",
     "단일 파일 크기 한도 초과", "Dépasse la limite par fichier", "Supera el límite por archivo",
     "Supera il limite per file", "Überschreitet das Limit pro Datei", "Excede o limite por arquivo"),
    ("还不行 → 双击",
     "Still failing → double-click ", "還不行 → 雙擊", "それでもだめなら → ダブルクリック：",
     "그래도 안 되면 → 더블클릭: ", "Ça ne marche toujours pas → double-cliquez sur ", "Si sigue fallando → haz doble clic en ",
     "Se ancora non funziona → fai doppio clic su ", "Immer noch nicht → doppelklicke auf ", "Se ainda não funcionar → clique duas vezes em "),
    ("重新加载本页",
     "Reload this page", "重新載入本頁", "このページを再読み込み", "이 페이지 다시 불러오기",
     "Recharger cette page", "Recargar esta página", "Ricarica questa pagina", "Diese Seite neu laden", "Recarregar esta página"),
    ("页面脚本出错了",
     "A script error occurred on the page", "頁面腳本出錯了", "ページのスクリプトでエラーが発生しました",
     "페이지 스크립트에 오류가 발생했습니다", "Une erreur de script s'est produite sur la page", "Se produjo un error de script en la página",
     "Si è verificato un errore di script nella pagina", "Auf der Seite ist ein Skriptfehler aufgetreten", "Ocorreu um erro de script na página"),
    ("（一键修复：重启服务 + 打开页面）。",
     " (one-click repair: restart the service and reopen the page).", "（一鍵修復：重啟服務 + 開啟頁面）。",
     "（ワンクリック修復：サービスを再起動してページを開く）。", "(원클릭 복구: 서비스 재시작 후 페이지 열기).",
     " (réparation en un clic : redémarrer le service et rouvrir la page).", " (reparación en un clic: reiniciar el servicio y abrir la página).",
     " (riparione con un clic: riavvia il servizio e riapri la pagina).", " (Ein-Klick-Reparatur: Dienst neu starten und Seite öffnen).",
     " (reparo com um clique: reinicie o serviço e abra a página)."),
    ("（强制刷新，绕过缓存）。",
     " (hard refresh to bypass the cache).", "（強制重新整理，繞過快取）。", "（キャッシュを無視して強制再読み込み）。",
     "(강제 새로 고침, 캐시 우회).", " (rechargement forcé pour contourner le cache).", " (recarga forzada para omitir la caché).",
     " (ricaricamento forzato per bypassare la cache).", " (Hard-Refresh zum Umgehen des Caches).", " (recarga forçada para ignorar o cache)."),
    # —— Visual Editor 零散 ——
    ("正在加载 Visual Editor…",
     "Loading Visual Editor…", "正在載入 Visual Editor…", "Visual Editor を読み込み中…",
     "Visual Editor 로드 중…", "Chargement de Visual Editor…", "Cargando Visual Editor…",
     "Caricamento di Visual Editor…", "Visual Editor wird geladen…", "Carregando Visual Editor…"),
    ("活动轨迹已改为 Hero 下方固定横线，无需手绘。",
     "The activity track is now a fixed line below the Hero — no need to draw it by hand.",
     "活動軌跡已改為 Hero 下方固定橫線，無需手繪。", "活動トラックは Hero 直下の固定ラインになりました。手描きは不要です。",
     "활동 트랙은 Hero 아래 고정 라인으로 변경되었습니다. 수동 그리기가 필요 없습니다.",
     "La piste d'activité est désormais une ligne fixe sous le Hero — plus besoin de la dessiner.",
     "La pista de actividad ahora es una línea fija bajo el Hero; no hace falta dibujarla a mano.",
     "La traccia attività è ora una linea fissa sotto l'Hero — non serve disegnarla a mano.",
     "Die Aktivitätsspur ist jetzt eine feste Linie unter dem Hero — kein manuelles Zeichnen nötig.",
     "A trilha de atividades agora é uma linha fixa abaixo do Hero — não é preciso desenhá-la à mão."),
    ("等了 12 秒还没加载完",
     "Still not loaded after 12 seconds", "等了 12 秒還沒載入完", "12秒待っても読み込みが完了しません",
     "12초를 기다려도 로드되지 않았습니다", "Toujours pas chargé après 12 secondes", "Sigue sin cargar tras 12 segundos",
     "Non ancora caricato dopo 12 secondi", "Nach 12 Sekunden immer noch nicht geladen", "Ainda não carregou após 12 segundos"),
    ("请先在画布中选中文字",
     "Select some text on the canvas first", "請先在畫布中選中文字", "まずキャンバスで文字を選択してください",
     "먼저 캔버스에서 텍스트를 선택하세요", "Sélectionnez d'abord du texte sur le canevas", "Primero selecciona texto en el lienzo",
     "Seleziona prima del testo sulla tela", "Wähle zuerst Text auf der Leinwand aus", "Primeiro selecione o texto na tela"),
    # —— Studio 发布失败卡 1：CloudBase COS 写权限 ——（按 DOM 文本节点拆条）
    ("你当前的密钥能读取 CloudBase 环境，但",
     "Your current key can read the CloudBase environment, but ",
     "你目前的金鑰能讀取 CloudBase 環境，但", "現在のキーは CloudBase 環境を読み取れますが、",
     "현재 키는 CloudBase 환경을 읽을 수 있지만, ", "Votre clé actuelle peut lire l'environnement CloudBase, mais ",
     "Tu clave actual puede leer el entorno de CloudBase, pero ", "La tua chiave attuale può leggere l'ambiente CloudBase, ma ",
     "Dein aktueller Schlüssel kann die CloudBase-Umgebung lesen, aber ", "Sua chave atual pode ler o ambiente do CloudBase, mas "),
    ("没有对象存储的写权限",
     "does not have write permission for object storage",
     "沒有物件儲存的寫入權限", "オブジェクトストレージの書き込み権限がありません",
     "객체 스토리지 쓰기 권한이 없습니다", "n'a pas la permission d'écriture sur le stockage objet",
     "no tiene permiso de escritura en el almacenamiento de objetos", "non ha il permesso di scrittura sull'object storage",
     "keine Schreibberechtigung für den Objektspeicher hat", "não tem permissão de gravação no armazenamento de objetos"),
    ("——上传文件底层就是往对象存储（COS）里写对象，所以每个文件都被拒。这不是\"没授权\"，而是",
     "— uploading files is, under the hood, writing objects into object storage (COS), so every file is rejected. This is not \"unauthorized\"; it is ",
     "——上傳檔案底層就是往物件儲存（COS）裡寫物件，所以每個檔案都被拒。這不是「沒授權」，而是",
     "——ファイルのアップロードは内部的にオブジェクトストレージ（COS）への書き込みなので、全ファイルが拒否されます。これは「未承認」ではなく、",
     "——파일 업로드는 내부적으로 객체 스토리지(COS)에 쓰는 작업이라 모든 파일이 거부됩니다. 이것은 '미승인'이 아니라 ",
     "— téléverser un fichier revient, en interne, à écrire des objets dans le stockage objet (COS), donc chaque fichier est refusé. Ce n'est pas un « non autorisé », c'est ",
     "— subir archivos es, en el fondo, escribir objetos en el almacenamiento de objetos (COS), por eso se rechaza cada archivo. No es \"no autorizado\", sino ",
     "— caricare file significa, in sostanza, scrivere oggetti nell'object storage (COS), quindi ogni file viene rifiutato. Non è \"non autorizzato\", ma ",
     "— Dateien hochzuladen bedeutet im Kern, Objekte in den Objektspeicher (COS) zu schreiben, daher wird jede Datei abgelehnt. Das ist keine „Nicht autorisiert“-Meldung, sondern ",
     "— enviar arquivos é, por baixo dos panos, gravar objetos no armazenamento de objetos (COS), por isso cada arquivo é rejeitado. Não é \"não autorizado\", e sim "),
    ("策略挂错了层",
     "the policy is attached at the wrong level", "策略掛錯了層", "ポリシーを違う階層に付けています",
     "정책을 잘못된 계층에 연결한 것입니다", "la stratégie est attachée au mauvais niveau", "la política está asociada al nivel equivocado",
     "la policy è collegata al livello sbagliato", "die Richtlinie auf der falschen Ebene hängt", "a política está anexada ao nível errado"),
    ("：只挂 CloudBase 自身的策略不够。到 ",
     ": attaching only the CloudBase policy itself is not enough. Go to ",
     "：只掛 CloudBase 自身的策略不夠。到 ", "：CloudBase 自身のポリシーだけでは不十分です。次へ：",
     ": CloudBase 자체 정책만으로는 부족합니다. 다음으로 이동: ", " : attacher uniquement la stratégie CloudBase elle-même ne suffit pas. Allez sur ",
     ": asociar solo la política propia de CloudBase no es suficiente. Ve a ", ": collegare solo la policy di CloudBase non basta. Vai su ",
     ": nur die CloudBase-eigene Richtlinie anzuhängen reicht nicht. Gehe zu ", ": associar apenas a política do próprio CloudBase não é suficiente. Vá para "),
    ("访问管理 CAM ↗",
     "Access Management CAM ↗", "存取管理 CAM ↗", "アクセス管理 CAM ↗", "액세스 관리 CAM ↗",
     "Gestion des accès CAM ↗", "Gestión de accesos CAM ↗", "Gestione degli accessi CAM ↗",
     "Zugriffsverwaltung CAM ↗", "Gerenciamento de acesso CAM ↗"),
    (" → 左侧「用户」→「",
     " → in the left menu “Users” → “", " → 左側「使用者」→「", " → 左側メニューの「ユーザー」→「",
     " → 왼쪽 '사용자' → '", " → dans le menu de gauche « Utilisateurs » → « ", " → en el menú izquierdo \"Usuarios\" → \"",
     " → nel menu a sinistra \"Utenti\" → \"", " → im linken Menü „Benutzer“ → „", " → no menu esquerdo \"Usuários\" → \""),
    ("用户列表",
     "User list", "使用者列表", "ユーザーリスト", "사용자 목록", "Liste des utilisateurs", "Lista de usuarios",
     "Elenco utenti", "Benutzerliste", "Lista de usuários"),
    ("」→ 找到这把密钥对应的",
     "” → locate the ", "」→ 找到這把金鑰對應的", "」→ このキーが属する", "」→ 이 키가 속한 ",
     " » → repérez ", "” → localiza ", "” → individua ", "” → suche ", "” → localize "),
    ("子账号所在的那一行",
     "row of the sub-account this key belongs to",
     "子帳號所在的那一行", "サブアカウントの行を探します", "하위 계정의 행을 찾으세요",
     "la ligne du sous-compte auquel cette clé appartient", "la fila del subusuario al que pertenece esta clave",
     "la riga del sottaccount a cui appartiene questa chiave", "die Zeile des Subkontos, zu dem dieser Schlüssel gehört",
     "a linha da subconta à qual esta chave pertence"),
    ("，点该行右侧操作列的「",
     ", click “", "，點該行右側操作列的「", "、その行の右側操作列の「", ", 해당 행 오른쪽 작업 열의 '",
     ", cliquez sur « ", ", haz clic en \"", ", fai clic su \"", ", klicke in der Aktionsspalte auf „", ", clique em \""),
    ("授权",
     "Authorize", "授權", "権限付与", "권한 부여", "Autoriser", "Autorizar", "Autorizza", "Autorisieren", "Autorizar"),
    ("」（入口在列表行上；主账号行没有这个入口，也不必点进用户详情里找） → 在「关联策略」窗口搜 ",
     "” (the entry is on the list row itself; the root-account row has no such entry, and there is no need to dig into the user details) → in the “Associate policies” window search for ",
     "」（入口在列表行上；主帳號行沒有這個入口，也不必點進使用者詳情裡找） → 在「關聯策略」視窗搜 ",
     "」（入り口はリスト行上にあります。ルートアカウント行にはなく、ユーザー詳細を開く必要もありません）→「ポリシー関連付け」ウィンドウで検索：",
     "」(입구는 목록 행에 있습니다. 루트 계정 행에는 없으며 사용자 상세로 들어갈 필요도 없습니다) → '정책 연결' 창에서 검색: ",
     " » (l'entrée est sur la ligne de la liste ; la ligne du compte principal n'en a pas, et il est inutile d'ouvrir les détails de l'utilisateur) → dans la fenêtre « Associer des stratégies », recherchez ",
     "” (la entrada está en la fila de la lista; la fila de la cuenta principal no la tiene, y no hace falta entrar en los detalles del usuario) → en la ventana \"Asociar políticas\" busca ",
     "” (la voce è sulla riga dell'elenco; la riga dell'account principale non ce l'ha e non serve aprire i dettagli utente) → nella finestra \"Associa policy\" cerca ",
     "“ (der Einstieg liegt direkt auf der Listenzeile; die Zeile des Hauptkontos hat ihn nicht, und du musst nicht in die Benutzerdetails gehen) → suche im Fenster „Richtlinien zuordnen“ nach ",
     "” (a entrada fica na própria linha da lista; a linha da conta principal não a tem, e não é preciso entrar nos detalhes do usuário) → na janela \"Associar políticas\", pesquise "),
    (" → 勾选 → 确定（QcloudCOSFullAccess＝对象存储 COS 全读写访问权限，上传文件靠它，必须挂在这个子账号上）。",
     " → tick it → confirm (QcloudCOSFullAccess = full read/write access to object storage COS; file uploads rely on it and it must be attached to this sub-account).",
     " → 勾選 → 確定（QcloudCOSFullAccess＝物件儲存 COS 全讀寫存取權限，上傳檔案靠它，必須掛在這個子帳號上）。",
     " → チェック → OK（QcloudCOSFullAccess＝オブジェクトストレージ COS のフル読み書き権限。ファイルアップロードに必要で、このサブアカウントに付ける必要があります）。",
     " → 체크 → 확인(QcloudCOSFullAccess는 객체 스토리지 COS 전체 읽기/쓰기 권한이며 업로드에 필요하므로 이 하위 계정에 연결되어야 합니다).",
     " → cochez-la → validez (QcloudCOSFullAccess = accès complet en lecture/écriture au stockage objet COS ; le téléversement de fichiers en dépend et doit être attaché à ce sous-compte).",
     " → márcala → acepta (QcloudCOSFullAccess = acceso total de lectura/escritura al almacenamiento de objetos COS; las subidas dependen de él y debe asociarse a este subusuario).",
     " → spuntala → conferma (QcloudCOSFullAccess = accesso completo in lettura/scrittura all'object storage COS; il caricamento file dipende da esso e deve essere collegato a questo sottaccount).",
     " → anhaken → bestätigen (QcloudCOSFullAccess = voller Lese-/Schreibzugriff auf den Objektspeicher COS; Datei-Uploads hängen davon ab und müssen an dieses Unterkonto angehängt werden).",
     " → marque → confirme (QcloudCOSFullAccess = acesso total de leitura/gravação ao armazenamento de objetos COS; o envio de arquivos depende dele e deve ser anexado a esta subconta)."),
    # —— Studio 发布失败卡 2：Node.js ——
    ("这是运行环境问题：CloudBase CLI 需要 Node.js 才能跑。请先",
     "This is a runtime issue: the CloudBase CLI needs Node.js to run. First ",
     "這是執行環境問題：CloudBase CLI 需要 Node.js 才能跑。請先", "これは実行環境の問題です：CloudBase CLI の実行には Node.js が必要です。まず",
     "이것은 실행 환경 문제입니다: CloudBase CLI를 실행하려면 Node.js가 필요합니다. 먼저 ",
     "C'est un problème d'environnement : la CLI CloudBase a besoin de Node.js pour fonctionner. D'abord ",
     "Es un problema del entorno: la CLI de CloudBase necesita Node.js para funcionar. Primero ",
     "È un problema dell'ambiente: la CLI CloudBase richiede Node.js per funzionare. Prima ",
     "Das ist ein Laufzeitproblem: Die CloudBase-CLI benötigt Node.js. Zuerst ",
     "Este é um problema de ambiente: a CLI do CloudBase precisa do Node.js para funcionar. Primeiro "),
    ("重启 FolioFold 服务",
     "restart the FolioFold service", "重新啟動 FolioFold 服務", "FolioFold サービスを再起動", "FolioFold 서비스 재시작",
     "redémarrez le service FolioFold", "reinicia el servicio FolioFold", "riavvia il servizio FolioFold",
     "starte den FolioFold-Dienst neu", "reinicie o serviço FolioFold"),
    ("（双击启动脚本），本机已自带 Node.js 会自动修复。",
     " (double-click the launcher script); this machine ships with Node.js, so it will be fixed automatically.",
     "（雙擊啟動腳本），本機已自帶 Node.js 會自動修復。", "（起動スクリプトをダブルクリック）。このマシンには Node.js が同梱されており、自動で修復されます。",
     "(시작 스크립트를 더블클릭하세요). 이 컴퓨터에는 Node.js가 내장되어 있어 자동으로 복구됩니다.",
     " (double-cliquez sur le script de lancement) ; cette machine embarque Node.js, il sera donc réparé automatiquement.",
     " (haz doble clic en el script de inicio); esta máquina incluye Node.js, así que se reparará automáticamente.",
     " (fai doppio clic sul script di avvio); questa macchina include Node.js, quindi verrà riparato automaticamente.",
     " (doppelklicke auf das Startscript); dieser Rechner bringt Node.js mit, es wird also automatisch repariert.",
     " (clique duas vezes no script de inicialização); esta máquina já vem com Node.js, então será corrigido automaticamente."),
]


def main():
    srcs = {}
    for f in SRC_FILES:
        try:
            srcs[f] = io.open(os.path.join(ROOT, f), encoding='utf-8').read()
        except Exception:
            srcs[f] = ''
    # —— 键 → 源码核对（防引号/空格错位）。⚠ 模板串会被「`+换行+`」拼接拆开，DOM 里才是
    #     连续文本节点 —— 验证前先把拼接缝移除再比对。 ——
    bad = []
    for row in T:
        key = row[0]
        hits = []
        for f, s in srcs.items():
            joined = s.replace('`\n          + `', '').replace("`\n        + `", '')
            if key in joined:
                hits.append(f)
        if not hits:
            bad.append(key)
    if bad:
        print('!! 以下 %d 个键在源码中找不到（引号/空格不一致？）:' % len(bad))
        for k in bad:
            print('   MISS:', repr(k))
        # 不中断：写入照常，但提示人工核对
    # —— 写词典 ——
    zh_path = os.path.join(HERE, 'zh.json')
    zh = json.load(io.open(zh_path, encoding='utf-8'))
    langd = {}
    for l in LANGS:
        langd[l] = json.load(io.open(os.path.join(HERE, 'zh.%s.json' % l), encoding='utf-8'))
    n = 0
    for row in T:
        key, en = row[0], row[1]
        zh[key] = en
        for l, v in zip(LANGS, row[2:]):
            langd[l][key] = v
        n += 1
    io.open(zh_path, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(zh, ensure_ascii=False, indent=1, sort_keys=True) + '\n')
    for l in LANGS:
        io.open(os.path.join(HERE, 'zh.%s.json' % l), 'w', encoding='utf-8', newline='\n').write(
            json.dumps(langd[l], ensure_ascii=False, indent=1, sort_keys=True) + '\n')
    print('写入 %d 键 × %d 语言 + en' % (n, len(LANGS)))
    # —— 编辑器错误页「文件名 第 N 行」是一条文本节点，走 patterns ——
    pat_path = os.path.join(HERE, 'patterns.json')
    pats = json.load(io.open(pat_path, encoding='utf-8'))
    src = '第 (\\d+) 行'
    if not any(p.get('src') == src for p in pats):
        pats.append({
            'src': src, 'en': 'line $1',
            'zh-TW': '第 $1 行', 'ja': '$1 行目', 'ko': '$1행',
            'fr': 'ligne $1', 'es': 'línea $1', 'it': 'riga $1', 'de': 'Zeile $1', 'pt': 'linha $1',
        })
        print('patterns +1（第 N 行）')
    # 「未确认提示」带语言名变量，走 patterns（9 语言），否则在非中文界面下算汉字残留
    # （2026-09-26 文案改版：不再出现「审核」字样 —— Review 是用户确认，不是后台审批）
    src2 = '^「(.+?)」的翻译还没有生成，或者还没有确认，暂时显示原文。可在 文本编辑 → 设置 → 语言设置 里生成或确认翻译。$'
    if not any(p.get('src') == src2 for p in pats):
        # 旧文案的 pattern 已由 _ff_pat_fix 就地改名；这里仅在缺失时补（幂等）
        for p in pats:
            if isinstance(p, dict) and '还没生成或还没通过审核' in str(p.get('src', '')):
                pats.remove(p)
                break
        pats.append({
            'src': src2,
            'en': 'The "$1" translation has not been generated, or has not been confirmed yet — showing the original text for now. You can generate or confirm it in Text Editor → Settings → Language settings.',
            'zh-TW': '「$1」的翻譯還沒產生，或者還沒確認，暫時顯示原文。可在 文本編輯 → 設定 → 語言設定 裡產生或確認翻譯。',
            'ja': '「$1」の翻訳はまだ生成されていないか、まだ確認されていないため、原文を表示しています。テキストエディター → 設定 → 言語設定 で生成・確認できます。',
            'ko': '\'$1\' 번역이 아직 생성되지 않았거나 아직 확인되지 않아 원문을 표시합니다. 텍스트 편집기 → 설정 → 언어 설정에서 생성하거나 확인할 수 있습니다.',
            'fr': 'La traduction « $1 » n’est pas encore générée, ou n’a pas encore été confirmée — affichage du texte original pour l’instant. Générez-la ou confirmez-la dans Éditeur de texte → Réglages → Paramètres de langue.',
            'es': 'La traducción de "$1" aún no se ha generado, o aún no se ha confirmado; se muestra el texto original por ahora. Puedes generarla o confirmarla en Editor de texto → Ajustes → Configuración de idioma.',
            'it': 'La traduzione di "$1" non è ancora stata generata, o non è stata ancora confermata — per ora viene mostrato il testo originale. Puoi generarla o confermarla in Editor di testo → Impostazioni → Impostazioni lingua.',
            'de': 'Die Übersetzung für „$1“ wurde noch nicht erzeugt oder noch nicht bestätigt — vorerst wird der Originaltext angezeigt. Erzeuge oder bestätige sie unter Texteditor → Einstellungen → Spracheinstellungen.',
            'pt': 'A tradução de "$1" ainda não foi gerada, ou ainda não foi confirmada — por enquanto, o texto original é exibido. Você pode gerá-la ou confirmá-la em Editor de texto → Configurações → Configurações de idioma.',
        })
        print('patterns +1（未确认提示）->', len(pats))
    io.open(pat_path, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(pats, ensure_ascii=False, indent=1) + '\n')

if __name__ == '__main__':
    main()
