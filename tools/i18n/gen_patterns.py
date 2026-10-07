# -*- coding: utf-8 -*-
"""一次性把 patterns.json 的 127 条正则扩上 zh-TW/fr/es/it/de/pt（按 index 对齐，防错位）。
跑完 build_dict.py 后本脚本完成使命。"""
import io, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
# 每行: (zh-TW, fr, es, it, de, pt)。$1/$2 与源正则捕获组一一对应。
T = [
# 0
("共 $1 項。點任意一項可以直接在畫布上找到它。刪哪一項都不影響其他項。", "$1 élément(s). Cliquez n’importe lequel pour le retrouver sur le canevas. En supprimer un n’affecte jamais les autres.", "$1 elemento(s). Haz clic en cualquiera para localizarlo en el lienzo. Eliminar uno nunca afecta a los demás.", "$1 elemento/i. Fai clic su uno qualsiasi per trovarlo sulla tela. Eliminarne uno non tocca mai gli altri.", "$1 Eintrag/Einträge. Klicke auf einen, um ihn auf der Leinwand zu finden. Das Löschen eines Eintrags berührt nie die anderen.", "$1 item(s). Clique em qualquer um para localizá-lo na tela. Excluir um nunca afeta os outros."),
# 1
("自由放置的圖片（$1）", "Images en placement libre ($1)", "Imágenes en colocación libre ($1)", "Immagini in posizionamento libero ($1)", "Frei platzierte Bilder ($1)", "Imagens em posicionamento livre ($1)"),
# 2
("已在「$1」裡加上一個新專案：名稱/時間/類型/角色可直接在畫布上點著改，介紹與媒體請到文字編輯補充", "Nouveau projet ajouté à « $1 » : nom / dates / type / rôle se modifient d’un clic sur le canevas ; ajoutez la présentation et les médias dans l’éditeur de texte", "Proyecto nuevo añadido a «$1»: nombre/fechas/tipo/rol se editan haciendo clic en el lienzo; añade la descripción y los medios en el editor de texto", "Nuovo progetto aggiunto a «$1»: nome/date/tipo/ruolo si modificano con un clic sulla tela; aggiungi descrizione e media nell’editor di testo", "Neues Projekt zu „$1“ hinzugefügt: Name/Datum/Typ/Rolle lassen sich direkt auf der Leinwand anklicken und ändern; Beschreibung und Medien im Texteditor ergänzen", "Novo projeto adicionado a «$1»: nome/datas/tipo/papel podem ser editados clicando na tela; adicione a descrição e as mídias no editor de texto"),
# 3
("【範本一】已同步", "[Modèle 1] Synchronisé", "[Plantilla 1] Sincronizada", "[Modello 1] Sincronizzato", "[Vorlage 1] Synchronisiert", "[Modelo 1] Sincronizado"),
# 4
("【範本$1】已同步", "[Modèle $1] Synchronisé", "[Plantilla $1] Sincronizada", "[Modello $1] Sincronizzato", "[Vorlage $1] Synchronisiert", "[Modelo $1] Sincronizado"),
# 5
("【範本一】內容待更新", "[Modèle 1] Contenu à mettre à jour", "[Plantilla 1] Contenido por actualizar", "[Modello 1] Contenuto da aggiornare", "[Vorlage 1] Inhalt zu aktualisieren", "[Modelo 1] Conteúdo precisa de atualização"),
# 6
("【範本$1】內容待更新", "[Modèle $1] Contenu à mettre à jour", "[Plantilla $1] Contenido por actualizar", "[Modello $1] Contenuto da aggiornare", "[Vorlage $1] Inhalt zu aktualisieren", "[Modelo $1] Conteúdo precisa de atualização"),
# 7
("【範本一】排版待更新", "[Modèle 1] Mise en page à mettre à jour", "[Plantilla 1] Diseño por actualizar", "[Modello 1] Impaginazione da aggiornare", "[Vorlage 1] Layout zu aktualisieren", "[Modelo 1] Layout precisa de atualização"),
# 8
("【範本$1】排版待更新", "[Modèle $1] Mise en page à mettre à jour", "[Plantilla $1] Diseño por actualizar", "[Modello $1] Impaginazione da aggiornare", "[Vorlage $1] Layout zu aktualisieren", "[Modelo $1] Layout precisa de atualização"),
# 9
("【範本一】", "[Modèle 1]", "[Plantilla 1]", "[Modello 1]", "[Vorlage 1]", "[Modelo 1]"),
# 10
("【範本$1】", "[Modèle $1]", "[Plantilla $1]", "[Modello $1]", "[Vorlage $1]", "[Modelo $1]"),
# 11
("自動翻譯沒成功（$1），先按原文顯示", "La traduction automatique a échoué ($1) — affichage du texte d’origine pour l’instant", "La traducción automática falló ($1) — se muestra el texto original por ahora", "La traduzione automatica non è riuscita ($1) — per ora viene mostrato il testo originale", "Automatische Übersetzung fehlgeschlagen ($1) — vorerst Originaltext", "A tradução automática falhou ($1) — por ora, exibindo o texto original"),
# 12
("自動翻譯完成，已切換為$1", "Traduction automatique terminée — basculé en $1", "Traducción automática terminada — cambiado a $1", "Traduzione automatica completata — passato a $1", "Automatische Übersetzung fertig — umgeschaltet auf $1", "Tradução automática concluída — mudado para $1"),
# 13
("1 個專案", "1 projet", "1 proyecto", "1 progetto", "1 Projekt", "1 projeto"),
# 14
("$1 個專案", "$1 projets", "$1 proyectos", "$1 progetti", "$1 Projekte", "$1 projetos"),
# 15
("目前時間 $1 / 總時長 $2", "Actuel $1 / durée totale $2", "Actual $1 / duración total $2", "Attuale $1 / durata totale $2", "Aktuell $1 / Gesamtdauer $2", "Atual $1 / duração total $2"),
# 16
("目前專案已有 $1 個章節（換影片不會清掉它們）", "Ce projet a déjà $1 chapitres (changer la vidéo ne les effacera pas)", "Este proyecto ya tiene $1 capítulos (cambiar el vídeo no los borrará)", "Questo progetto ha già $1 capitoli (cambiare il video non li cancellerà)", "Dieses Projekt hat bereits $1 Kapitel (ein Videowechsel löscht sie nicht)", "Este projeto já tem $1 capítulos (trocar o vídeo não os apagará)"),
# 17
("目前來源：$1", "Source actuelle : $1", "Fuente actual: $1", "Sorgente attuale: $1", "Aktuelle Quelle: $1", "Fonte atual: $1"),
# 18
("正在讀取「$1」的資訊…", "Lecture des informations de « $1 »…", "Leyendo la información de «$1»…", "Lettura delle informazioni di «$1»…", "Informationen zu „$1“ werden gelesen…", "Lendo as informações de «$1»…"),
# 19
("顯示在「$1」這個區塊的標題旁邊（編號右側）。圖片按自身比例縮放並鎖在標題行高度內，任何範本 / 任何區塊順序都自動生效。", "Affichée à côté du titre de la section « $1 » (à droite du numéro). L’image garde son ratio et reste à la hauteur de la ligne de titre — marche avec tout modèle et tout ordre de sections.", "Se muestra junto al título de la sección «$1» (a la derecha del número). La imagen mantiene su proporción y queda a la altura de la línea del título: funciona con cualquier plantilla y orden de secciones.", "Mostrata accanto al titolo della sezione «$1» (a destra del numero). L’immagine mantiene le sue proporzioni e resta all’altezza della riga del titolo: funziona con qualsiasi modello e ordine delle sezioni.", "Neben dem Titel der Sektion „$1“ angezeigt (rechts der Nummer). Das Bild behält sein Seitenverhältnis und bleibt auf Titelzeilenhöhe — funktioniert mit jeder Vorlage und jeder Blockreihenfolge.", "Mostrada junto ao título da seção «$1» (à direita do número). A imagem mantém a proporção e fica na altura da linha do título: funciona com qualquer modelo e ordem de seções."),
# 20
("【$1】已同步", "[$1] Synchronisé", "[$1] Sincronizado", "[$1] Sincronizzato", "[$1] Synchronisiert", "[$1] Sincronizado"),
# 21
("【$1】內容待更新", "[$1] Contenu à mettre à jour", "[$1] Contenido por actualizar", "[$1] Contenuto da aggiornare", "[$1] Inhalt zu aktualisieren", "[$1] Conteúdo precisa de atualização"),
# 22
("【$1】排版待更新", "[$1] Mise en page à mettre à jour", "[$1] Diseño por actualizar", "[$1] Impaginazione da aggiornare", "[$1] Layout zu aktualisieren", "[$1] Layout precisa de atualização"),
# 23
("【$1】", "[$1]", "[$1]", "[$1]", "[$1]", "[$1]"),
# 24
("範本一", "Modèle 1", "Plantilla 1", "Modello 1", "Vorlage 1", "Modelo 1"),
# 25
("範本$1", "Modèle $1", "Plantilla $1", "Modello $1", "Vorlage $1", "Modelo $1"),
# 26
("共 $1 項。點畫布上的圖可單獨調大小 / 移動；這裡可一鍵刪除，刪哪一項都不影響其他項。", "$1 élément(s). Les images du canevas se redimensionnent / déplacent individuellement ; suppression en un clic ici — en supprimer une n’affecte jamais les autres.", "$1 elemento(s). Las imágenes del lienzo se redimensionan / mueven individualmente; aquí se eliminan de un clic: borrar una no afecta a las demás.", "$1 elemento/i. Le immagini della tela si ridimensionano / spostano singolarmente; qui si eliminano con un clic: eliminarne una non tocca le altre.", "$1 Eintrag/Einträge. Bilder auf der Leinwand lassen sich einzeln in der Größe ändern / verschieben; hier mit einem Klick löschbar — das Löschen eines Eintrags berührt nie die anderen.", "$1 item(s). As imagens da tela se redimensionam / movem individualmente; aqui se excluem com um clique: excluir uma não afeta as outras."),
# 27
("內容裡的媒體（$1）", "Médias de ce contenu ($1)", "Medios de este contenido ($1)", "Media di questo contenuto ($1)", "Medien dieses Inhalts ($1)", "Mídia deste conteúdo ($1)"),
# 28
("最低安全高度：$1px（由目前內容實際高度計算）", "Hauteur minimale sûre : $1 px (calculée d’après la hauteur réelle du contenu)", "Altura mínima segura: $1 px (calculada a partir da altura real do conteúdo)", "Altezza minima sicura: $1 px (calcolata dall’altezza reale del contenuto)", "Minimale sichere Höhe: $1 px (aus der tatsächlichen Inhaltshöhe berechnet)", "Altura mínima segura: $1 px (calculada a partir da altura real do conteúdo)"),
# 29
("（已用 $1 秒）", " ($1 s écoulées)", " ($1 s transcurridos)", " ($1 s trascorsi)", " ($1 s vergangen)", " ($1 s decorridos)"),
# 30
("已用 $1 秒", "$1 s écoulées", "$1 s transcurridos", "$1 s trascorsi", "$1 s vergangen", "$1 s decorridos"),
# 31
("共 $1 個字元（含完整版式與區塊順序，不依賴任何伺服器，另一台電腦上貼上即可還原）", "$1 caractères (avec la mise en page et l’ordre des sections ; sans serveur — collez-le sur un autre ordinateur pour tout restaurer)", "$1 caracteres (incluye el diseño y el orden de los bloques; sin servidor: pégalo en otro ordenador para restaurarlo)", "$1 caratteri (include il layout e l’ordine dei blocchi; senza server: incollalo su un altro computer per ripristinarlo)", "$1 Zeichen (mit vollständigem Layout und Blockreihenfolge; ohne Server — auf einem anderen Computer einfügen, um alles wiederherzustellen)", "$1 caracteres (inclui o layout e a ordem dos blocos; sem servidor — cole em outro computador para restaurar)"),
# 32
("範本已打包進自包含範本碼（$1 字元）", "Modèle empaqueté en code autonome ($1 caractères)", "Plantilla empaquetada en código autocontenido ($1 caracteres)", "Modello impacchettato in codice autonomo ($1 caratteri)", "Vorlage als in sich geschlossener Code gepackt ($1 Zeichen)", "Modelo empacotado em código autossuficiente ($1 caracteres)"),
# 33
("已加入到：$1", "Ajouté à : $1", "Añadido a: $1", "Aggiunto a: $1", "Hinzugefügt zu: $1", "Adicionado a: $1"),
# 34
("加入到：$1", "Ajouter à : $1", "Añadir a: $1", "Aggiungi a: $1", "Hinzufügen zu: $1", "Adicionar a: $1"),
# 35
("正在產生 $1 項", "Génération de $1 élément(s)", "Generando $1 elemento(s)", "Generazione di $1 elemento/i", "$1 Eintrag/Einträge werden erzeugt", "Gerando $1 item(s)"),
# 36
("已刪除「$1」", "« $1 » supprimé", "«$1» eliminado", "«$1» eliminato", "„$1“ gelöscht", "«$1» excluído"),
# 37
("已展開「$1」", "« $1 » déplié", "«$1» desplegado", "«$1» espanso", "„$1“ ausgeklappt", "«$1» expandido"),
# 38
("已切換到「$1」", "Passé à « $1 »", "Cambiado a «$1»", "Passato a «$1»", "Gewechselt zu „$1“", "Mudado para «$1»"),
# 39
("已重新命名為「$1」", "Renommé en « $1 »", "Renombrado a «$1»", "Rinominato in «$1»", "Umbenannt in „$1“", "Renomeado para «$1»"),
# 40
("已新增空白範本「$1」", "Modèle vierge créé : « $1 »", "Plantilla vacía creada: «$1»", "Modello vuoto creato: «$1»", "Leere Vorlage erstellt: „$1“", "Modelo vazio criado: «$1»"),
# 41
("已刪除「$1」，已回到「$2」", "« $1 » supprimé ; retour à « $2 »", "«$1» eliminado; de vuelta a «$2»", "«$1» eliminato; si torna a «$2»", "„$1“ gelöscht; zurück zu „$2“", "«$1» excluído; de volta a «$2»"),
# 42
("已匯入為「$1」：版式來自範本，個人內容已帶過來，原範本未改動", "Importé comme « $1 » : la mise en page vient du modèle, vos contenus personnels ont été transportés, le modèle d’origine est intact", "Importado como «$1»: el diseño viene de la plantilla, tu contenido personal se trajo y la plantilla original no se tocó", "Importato come «$1»: il layout viene dal modello, i tuoi contenuti personali sono stati portati e il modello originale è intatto", "Als „$1“ importiert: Das Layout stammt aus der Vorlage, deine persönlichen Inhalte wurden mitgenommen, die Originalvorlage bleibt unverändert", "Importado como «$1»: o layout vem do modelo, seu conteúdo pessoal foi trazido e o modelo original não foi alterado"),
# 43
("已定位到「$1」：點「+ 新增」就往這個分類裡加專案", "Allé à « $1 » : cliquez « + Ajouter » pour mettre un projet dans cette catégorie", "Saltado a «$1»: pulsa «+ Añadir» para poner un proyecto en esta categoría", "Saltato a «$1»: premi «+ Aggiungi» per mettere un progetto in questa categoria", "Zu „$1“ gesprungen: klicke „+ Hinzufügen“, um ein Projekt in diese Kategorie zu setzen", "Saltado para «$1»: clique «+ Adicionar» para pôr um projeto nesta categoria"),
# 44
("已加上「$1」", "« $1 » ajouté", "«$1» añadido", "«$1» aggiunto", "„$1“ hinzugefügt", "«$1» adicionado"),
# 45
("已清空「$1」的媒體", "Médias de « $1 » vidés", "Medios de «$1» vaciados", "Media di «$1» svuotati", "Medien von „$1“ geleert", "Mídias de «$1» esvaziadas"),
# 46
("確定刪除「$1」？這會移除該範本的內容與版式，且無法復原。範本一（你的主作品集）與其他範本不受影響。", "Supprimer « $1 » ? Cela retire le contenu et la mise en page de ce modèle, sans retour possible. Le modèle 1 (votre portfolio principal) et les autres modèles ne sont pas touchés.", "¿Eliminar «$1»? Esto quita el contenido y el diseño de esta plantilla y no se puede deshacer. La plantilla 1 (tu portafolio principal) y las demás no se ven afectadas.", "Eliminare «$1»? Questo rimuove contenuto e layout di questo modello e non si può annullare. Il modello 1 (il tuo portfolio principale) e gli altri modelli non vengono toccati.", "„$1“ löschen? Damit werden Inhalt und Layout dieser Vorlage entfernt und können nicht wiederhergestellt werden. Vorlage 1 (dein Hauptportfolio) und die anderen Vorlagen bleiben unberührt.", "Excluir «$1»? Isso remove o conteúdo e o layout deste modelo e não pode ser desfeito. O modelo 1 (seu portfólio principal) e os outros não são afetados."),
# 47-61 占位：失败类单独生成（见 FAILS）
None, None, None, None, None, None, None, None, None, None, None, None, None, None, None,
# 62
("分享碼已複製", "Code de modèle copié", "Código de plantilla copiado", "Codice modello copiato", "Vorlagencode kopiert", "Código de modelo copiado"),
# 63
("已複製", "Copié", "Copiado", "Copiato", "Kopiert", "Copiado"),
# 64
("間距已儲存", "Espacement enregistré", "Espaciado guardado", "Spaziatura salvata", "Abstand gespeichert", "Espaçamento salvo"),
# 65
("間距已重新同步到最新值", "Espacement resynchronisé à la dernière valeur", "Espaciado resincronizado al último valor", "Spaziatura risincronizzata all’ultimo valore", "Abstand auf den letzten Wert neu synchronisiert", "Espaçamento ressincronizado com o último valor"),
# 66
("寬度已儲存（佔整行 $1%）", "Largeur enregistrée ($1 % de la rangée)", "Anchura guardada ($1 % de la fila)", "Larghezza salvata ($1 % della riga)", "Breite gespeichert ($1 % der Reihe)", "Largura salva ($1 % da linha)"),
# 67
("位置已調整", "Position ajustée", "Posición ajustada", "Posizione regolata", "Position angepasst", "Posição ajustada"),
# 68
("媒體欄已放到右邊", "Colonne média déplacée à droite", "Columna de medios movida a la derecha", "Colonna media spostata a destra", "Medienspalte nach rechts verschoben", "Coluna de mídia movida para a direita"),
# 69
("媒體欄已放到左邊", "Colonne média déplacée à gauche", "Columna de medios movida a la izquierda", "Colonna media spostata a sinistra", "Medienspalte nach links verschoben", "Coluna de mídia movida para a esquerda"),
# 70
("已關閉對稱模式", "Mode symétrique désactivé", "Modo simétrico desactivado", "Modalità simmetrica disattivata", "Symmetrischer Modus aus", "Modo simétrico desativado"),
# 71
("整行對齊：", "Alignement de rangée : ", "Alineación de fila: ", "Allineamento riga: ", "Reihenausrichtung: ", "Alinhamento de linha: "),
# 72
("媒體位置已儲存", "Position des médias enregistrée", "Posición de los medios guardada", "Posizione dei media salvata", "Medienposition gespeichert", "Posição da mídia salva"),
# 73
("媒體設定已儲存", "Réglages des médias enregistrés", "Ajustes de medios guardados", "Impostazioni media salvate", "Medieneinstellungen gespeichert", "Configurações de mídia salvas"),
# 74
("軌跡已儲存，形象已鎖定到軌跡上移動", "Trajectoire enregistrée ; l’avatar suit désormais la trajectoire", "Trayectoria guardada; el avatar queda fijado a ella", "Traiettoria salvata; l’avatar ora la segue", "Pfad gespeichert; der Avatar folgt jetzt dem Pfad", "Trajetória salva; o avatar agora segue a trajetória"),
# 75
("已選用 $1 作為 Web Preview（原片保留）", "$1 retenu comme Web Preview (l’original est conservé)", "$1 elegido como Web Preview (el original se conserva)", "$1 scelto come Web Preview (l’originale resta)", "$1 als Web Preview ausgewählt (das Original bleibt)", "$1 escolhido como Web Preview (o original é mantido)"),
# 76
("已刪除這一項媒體，其他項不受影響", "Ce média a été supprimé ; les autres ne sont pas touchés", "Este medio se ha eliminado; los demás no se ven afectados", "Questo media è stato eliminato; gli altri non vengono toccati", "Dieses Medium wurde gelöscht; die anderen bleiben unberührt", "Esta mídia foi excluída; as outras não são afetadas"),
# 77
("區塊 Logo 已加入並儲存", "Logo de section ajouté et enregistré", "Logo de la sección añadido y guardado", "Logo della sezione aggiunto e salvato", "Block-Logo hinzugefügt und gespeichert", "Logo da seção adicionado e salvo"),
# 78
("區塊 Logo 位置已更新", "Position du logo de section mise à jour", "Posición del logo de la sección actualizada", "Posizione del logo della sezione aggiornata", "Position des Block-Logos aktualisiert", "Posição do logo da seção atualizada"),
# 79
("區塊 Logo 已刪除", "Logo de section supprimé", "Logo de la sección eliminado", "Logo della sezione eliminato", "Block-Logo entfernt", "Logo da seção excluído"),
# 80
("已移除 Pixel 形象", "Avatar Pixel retiré", "Avatar Pixel quitado", "Avatar Pixel rimosso", "Pixel-Avatar entfernt", "Avatar Pixel removido"),
# 81
("已加上 Pixel", "Pixel ajouté", "Pixel añadido", "Pixel aggiunto", "Pixel hinzugefügt", "Pixel adicionado"),
# 82
("已移到「$1」", "Déplacé vers « $1 »", "Movido a «$1»", "Spostato in «$1»", "Verschoben nach „$1“", "Movido para «$1»"),
# 83
("正在體檢…（讀取環境並做零位元組寫入自測，測試檔案隨即刪除）", "Vérification… (lecture de l’environnement et auto-test d’écriture de zéro octet ; le fichier test est supprimé aussitôt)", "Comprobando… (lectura del entorno y autotest de escritura de cero bytes; el archivo de prueba se elimina de inmediato)", "Verifica in corso… (lettura dell’ambiente e auto-test di scrittura a zero byte; il file di prova viene eliminato subito)", "Prüfung… (Umgebung wird gelesen plus Schreib-Selbsttest mit null Byte; die Testdatei wird sofort gelöscht)", "Verificando… (leitura do ambiente e autoteste de escrita de zero bytes; o arquivo de teste é excluído logo em seguida)"),
# 84
("體檢請求失敗：$1", "Échec de la requête de vérification : $1", "Error en la solicitud de comprobación: $1", "Richiesta di verifica non riuscita: $1", "Prüfanfrage fehlgeschlagen: $1", "Falha na solicitação de verificação: $1"),
# 85
("權限體檢結果", "Résultat de la vérification des permissions", "Resultado de la comprobación de permisos", "Risultato della verifica dei permessi", "Ergebnis der Rechteprüfung", "Resultado da verificação de permissões"),
# 86
("✓ 權限已就緒，點上面的「⟳ 更新發布」即可。", "✓ Permissions prêtes. Cliquez « ⟳ Republier » ci-dessus.", "✓ Permisos listos. Pulsa «⟳ Publicar de nuevo» arriba.", "✓ Permessi pronti. Premi «⟳ Pubblica di nuovo» sopra.", "✓ Rechte stehen bereit. Oben „⟳ Erneut veröffentlichen“ klicken.", "✓ Permissões prontas. Clique «⟳ Publicar de novo» acima."),
# 87
("怎麼修：", "Comment corriger :", "Cómo corregirlo:", "Come correggere:", "So lässt es sich beheben:", "Como corrigir:"),
# 88
("正在打包…（媒體較多時需要十幾秒到幾分鐘，請勿關閉）", "Empaquetage… (avec beaucoup de médias, de dizaines de secondes à quelques minutes — ne fermez pas)", "Empaquetando… (con muchos medios tarda de decenas de segundos a minutos; no lo cierres)", "Pacchetto in preparazione… (con molti media richiede da decine di secondi a minuti; non chiudere)", "Wird gepackt… (bei vielen Medien dauert es von einigen Sekunden bis Minuten — bitte offen lassen)", "Empacotando… (com muitas mídias leva de dezenas de segundos a minutos; não feche)"),
# 89
("正在打包完整版（含所有大媒體），耗時更長…", "Empaquetage de la version complète (avec tous les gros médias) — plus long…", "Empaquetando la versión completa (con todos los medios grandes): tarda más…", "Preparazione della versione completa (con tutti i media grandi): più lunga…", "Vollversion wird gepackt (mit allen großen Mediendateien) — dauert länger…", "Empacotando a versão completa (com todas as mídias grandes): demora mais…"),
# 90
("發布超過 $1 分鐘仍沒有結果，已停止等待。請先開啟公開網址確認頁面是否已更新：若已更新就不需要再發布一次。", "La publication n’a donné aucun résultat après $1 minutes : nous avons cessé d’attendre. Ouvrez d’abord l’URL publique pour vérifier si la page s’est mise à jour ; si c’est le cas, inutile de republier.", "La publicación no dio resultado tras $1 minutos: dejamos de esperar. Abre primero la URL pública para comprobar si la página ya se actualizó; si es así, no hace falta publicar de nuevo.", "La pubblicazione non ha dato risultato dopo $1 minuti: abbiamo smesso di attendere. Apri prima l’URL pubblico per verificare se la pagina si è aggiornata; in tal caso non serve pubblicare di nuovo.", "Die Veröffentlichung brachte nach $1 Minuten kein Ergebnis, wir haben das Warten beendet. Öffne zuerst die öffentliche URL und prüfe, ob die Seite schon aktualisiert ist: Falls ja, ist erneutes Veröffentlichen nicht nötig.", "A publicação não deu resultado após $1 minutos: paramos de esperar. Abra primeiro a URL pública para verificar se a página já atualizou; se sim, não é preciso publicar de novo."),
# 91
("正在提交發布請求…", "Envoi de la requête de publication…", "Enviando la solicitud de publicación…", "Invio della richiesta di pubblicazione…", "Veröffentlichungsanfrage wird gesendet…", "Enviando a solicitação de publicação…"),
# 92
("發布中…", "Publication…", "Publicando…", "Pubblicazione…", "Wird veröffentlicht…", "Publicando…"),
# 93
("正在向 GitHub 申請授權碼…", "Demande d’un code d’autorisation à GitHub…", "Solicitando un código de autorización a GitHub…", "Richiesta di un codice di autorizzazione a GitHub…", "Autorisierungscode wird bei GitHub angefragt…", "Solicitando um código de autorização ao GitHub…"),
# 94
("在 GitHub 頁面輸入下面的代碼（已自動複製，可直接貼上）：", "Saisissez le code ci-dessous sur la page GitHub (déjà copié — il suffit de le coller) :", "Introduce el código siguiente en la página de GitHub (ya copiado: solo pégalo):", "Inserisci il codice seguente nella pagina GitHub (già copiato: basta incollarlo):", "Gib den folgenden Code auf der GitHub-Seite ein (bereits kopiert — einfach einfügen):", "Digite o código abaixo na página do GitHub (já copiado — basta colar):"),
# 95
("等你在 GitHub 上完成授權…", "En attente de la fin de votre autorisation sur GitHub…", "Esperando a que termines la autorización en GitHub…", "In attesa che completi l’autorizzazione su GitHub…", "Warten, bis du die Autorisierung auf GitHub abgeschlossen hast…", "Aguardando você concluir a autorização no GitHub…"),
# 96
("授權碼已過期，請重新點擊「連接 GitHub」。", "Le code a expiré. Cliquez de nouveau « Connecter GitHub ».", "El código expiró. Pulsa de nuevo «Conectar GitHub».", "Il codice è scaduto. Premi di nuovo «Connetti GitHub».", "Der Code ist abgelaufen. Klicke erneut auf „GitHub verbinden“.", "O código expirou. Clique de novo «Conectar GitHub»."),
# 97
("你在 GitHub 上拒絕了授權。", "Vous avez refusé l’autorisation sur GitHub.", "Has rechazado la autorización en GitHub.", "Hai rifiutato l’autorizzazione su GitHub.", "Du hast die Autorisierung auf GitHub abgelehnt.", "Você recusou a autorização no GitHub."),
# 98
("已連接，但該授權無法新增儲存庫，請看面板提示", "Connecté, mais cette autorisation ne permet pas de créer des dépôts — voir la note du panneau", "Conectado, pero esta autorización no puede crear repositorios: vea la nota del panel", "Connesso, ma questa autorizzazione non può creare repository — vedi la nota del pannello", "Verbunden, aber diese Autorisierung kann keine Repositories anlegen — siehe Hinweis im Panel", "Conectado, mas esta autorização não pode criar repositórios — veja a nota do painel"),
# 99
("GitHub 已連接 ✓", "GitHub connecté ✓", "GitHub conectado ✓", "GitHub connesso ✓", "GitHub verbunden ✓", "GitHub conectado ✓"),
# 100
("申請失敗：$1", "Échec de la demande : $1", "Error en la solicitud: $1", "Richiesta non riuscita: $1", "Anfrage fehlgeschlagen: $1", "Falha na solicitação: $1"),
# 101
("請先貼上範本碼、選擇檔案或貼上範本內容", "Collez d’abord le code de modèle, choisissez un fichier ou collez le contenu du modèle", "Pega primero el código de plantilla, elige un archivo o pega el contenido de la plantilla", "Incolla prima il codice modello, scegli un file o incolla il contenuto del modello", "Zuerst den Vorlagencode einfügen, eine Datei wählen oder den Vorlageninhalt einfügen", "Cole primeiro o código do modelo, escolha um arquivo ou cole o conteúdo do modelo"),
# 102
("檔案不是合法 JSON：$1", "Le fichier n’est pas un JSON valide : $1", "El archivo no es JSON válido: $1", "Il file non è JSON valido: $1", "Die Datei ist kein gültiges JSON: $1", "O arquivo não é JSON válido: $1"),
# 103
("貼上的內容不是合法 JSON：$1", "Le contenu collé n’est pas un JSON valide : $1", "El contenido pegado no es JSON válido: $1", "Il contenuto incollato non è JSON valido: $1", "Der eingefügte Inhalt ist kein gültiges JSON: $1", "O conteúdo colado não é JSON válido: $1"),
# 104
("範本已匯入：版式 + 區塊順序已更新，個人內容一字未動", "Modèle importé : mise en page et ordre des sections mis à jour, vos contenus personnels n’ont pas bougé d’un iota", "Plantilla importada: diseño y orden de bloques actualizados; tu contenido personal no cambió ni una letra", "Modello importato: layout e ordine dei blocchi aggiornati; i tuoi contenuti personali non sono stati toccati", "Vorlage importiert: Layout und Blockreihenfolge aktualisiert; deine persönlichen Inhalte blieben unverändert", "Modelo importado: layout e ordem dos blocos atualizados; seu conteúdo pessoal não mudou uma letra"),
# 105
("範本檔案已開始下載（只含版式，不含個人內容）", "Le fichier de modèle a commencé à se télécharger (mise en page uniquement, sans contenu personnel)", "El archivo de plantilla comenzó a descargarse (solo diseño, sin contenido personal)", "Il download del file modello è iniziato (solo layout, senza contenuti personali)", "Der Download der Vorlagendatei hat begonnen (nur Layout, ohne persönliche Inhalte)", "O download do arquivo de modelo começou (só layout, sem conteúdo pessoal)"),
# 106
("範本一是目前作品集本體，不能刪除", "Le modèle 1 est votre portfolio principal et ne peut pas être supprimé", "La plantilla 1 es tu portafolio principal y no puede eliminarse", "Il modello 1 è il tuo portfolio principale e non può essere eliminato", "Vorlage 1 ist dein Hauptportfolio und kann nicht gelöscht werden", "O modelo 1 é seu portfólio principal e não pode ser excluído"),
# 107
("編輯器無法載入：$1", "L’éditeur n’a pas pu se charger : $1", "El editor no pudo cargarse: $1", "L’editor non si è potuto caricare: $1", "Der Editor konnte nicht geladen werden: $1", "O editor não pôde ser carregado: $1"),
# 108
("Visual Editor 載入失敗：$1", "Échec du chargement de Visual Editor : $1", "Visual Editor falló al cargarse: $1", "Caricamento di Visual Editor non riuscito: $1", "Visual Editor konnte nicht geladen werden: $1", "Visual Editor falhou ao carregar: $1"),
# 109
("讀取部署狀態中…", "Lecture de l’état de déploiement…", "Leyendo el estado de despliegue…", "Lettura dello stato di distribuzione…", "Deploy-Status wird gelesen…", "Lendo o estado de implantação…"),
# 110
("點文字即可改。", "Cliquez un texte pour l’éditer.", "Haz clic en un texto para editarlo.", "Fai clic su un testo per modificarlo.", "Text anklicken, um ihn zu bearbeiten.", "Clique em um texto para editá-lo."),
# 111
("留空恢復預設：$1", "Laisser vide pour restaurer le défaut : $1", "Dejar en blanco para restaurar el valor por defecto: $1", "Lascia vuoto per ripristinare il valore predefinito: $1", "Leer lassen, um den Standard wiederherzustellen: $1", "Deixe em branco para restaurar o padrão: $1"),
# 112
("已翻譯 $1 條文案", "$1 chaînes traduites", "$1 cadenas traducidos", "$1 string tradotte", "$1 Zeichenketten übersetzt", "$1 textos traduzidos"),
# 113
("整篇翻譯完成：共更新 $1 條", "Traduction complète terminée : $1 chaînes mises à jour", "Traducción completa terminada: $1 cadenas actualizadas", "Traduzione completa terminata: $1 string aggiornate", "Komplettübersetzung fertig: $1 Zeichenketten aktualisiert", "Tradução completa concluída: $1 textos atualizados"),
# 114
("【$1】$2", "[$1] $2", "[$1] $2", "[$1] $2", "[$1] $2", "[$1] $2"),
# 115
("刪除分類「$1」？該分類下的 $2 個專案會移到「$3」。", "Supprimer la catégorie « $1 » ? Ses $2 projet(s) iront dans « $3 ».", "¿Eliminar la categoría «$1»? Sus $2 proyecto(s) se moverán a «$3».", "Eliminare la categoria «$1»? I suoi $2 progetto/i passeranno a «$3».", "Kategorie „$1“ löschen? Ihre $2 Projekt(e) werden nach „$3“ verschoben.", "Excluir a categoria «$1»? Seus $2 projeto(s) irão para «$3»."),
# 116
("已刪除分類「$1」$2。", "Catégorie « $1 » supprimée$2.", "Categoría «$1» eliminada$2.", "Categoria «$1» eliminata$2.", "Kategorie „$1“ gelöscht$2.", "Categoria «$1» excluída$2."),
# 117
("已刪除分類「$1」", "Catégorie « $1 » supprimée", "Categoría «$1» eliminada", "Categoria «$1» eliminata", "Kategorie „$1“ gelöscht", "Categoria «$1» excluída"),
# 118
("正在自動翻譯本範本的內容…已用 $1 秒", "Traduction automatique de ce modèle… $1 s écoulées", "Traducción automática de esta plantilla… $1 s transcurridos", "Traduzione automatica di questo modello… $1 s trascorsi", "Diese Vorlage wird automatisch übersetzt… $1 s vergangen", "Tradução automática deste modelo… $1 s decorridos"),
# 119
("將整篇翻譯為 $1", "Traduire tout le portfolio en $1", "Traducir todo el portafolio al $1", "Traduci l’intero portfolio in $1", "Das gesamte Portfolio ins $1 übersetzen", "Traduzir todo o portfólio para $1"),
# 120
("· $1 · 時長 $2 · $3 · 單檔上限 $4", "· $1 · Durée $2 · $3 · limite par fichier $4", "· $1 · Duración $2 · $3 · límite por archivo $4", "· $1 · Durata $2 · $3 · limite per file $4", "· $1 · Dauer $2 · $3 · Limit pro Datei $4", "· $1 · Duração $2 · $3 · limite por arquivo $4"),
# 121
("· $1 · $2×$3 · 影片 $4k / 音訊 $5k", "· $1 · $2×$3 · vidéo $4k / audio $5k", "· $1 · $2×$3 · vídeo $4k / audio $5k", "· $1 · $2×$3 · video $4k / audio $5k", "· $1 · $2×$3 · Video $4k / Audio $5k", "· $1 · $2×$3 · vídeo $4k / áudio $5k"),
# 122
("✓ 已壓縮版本（$1）· 發布後瀏覽器可直接線上播放，原片已保留", "✓ Version compressée ($1) · lisible directement en ligne après publication ; l’original est conservé", "✓ Versión comprimida ($1) · se reproduce directamente en el navegador tras publicar; el original se conserva", "✓ Versione compressa ($1) · riproducibile direttamente online dopo la pubblicazione; l’originale è conservato", "✓ Komprimierte Version ($1) · nach dem Veröffentlichen direkt im Browser abspielbar; das Original bleibt erhalten", "✓ Versão comprimida ($1) · reproduz diretamente no navegador após publicar; o original é mantido"),
# 123
("主展示區是人名牌區域，位置與字號固定，最多 $1 項。", "La zone principale est le porte-nom en haut de page : position et taille de police fixes, jusqu’à $1 éléments.", "La zona principal es la placa con el nombre en lo alto: posición y tamaño de letra fijos, hasta $1 elementos.", "La zona principale è la targhetta col nome in alto: posizione e corpo fissi, fino a $1 elementi.", "Die Hauptzone ist das Namensschild oben auf der Seite: Position und Schriftgröße sind fest, bis zu $1 Einträge.", "A zona principal é a placa de nome no topo: posição e tamanho de fonte fixos, até $1 itens."),
# 124
("次展示區是主展示區下方的資訊列，最多 $1 項。", "La zone secondaire est la colonne d’informations sous la zone principale, jusqu’à $1 éléments.", "La zona secundaria es la columna de información bajo la zona principal, hasta $1 elementos.", "La zona secondaria è la colonna informativa sotto la zona principale, fino a $1 elementi.", "Die Nebenzonen ist die Infospalte unter der Hauptzone, bis zu $1 Einträge.", "A zona secundária é a coluna de informações abaixo da zona principal, até $1 itens."),
# 125
("已選 $1 / $2", "$1 / $2 sélectionnés", "$1 / $2 seleccionados", "$1 / $2 selezionati", "$1 / $2 ausgewählt", "$1 / $2 selecionados"),
# 126
("（按 1 MB = $1 位元組算，和手機 / 微信 / 瀏覽器顯示的口徑一致）", "(1 Mo = $1 octets, comme l’affichent téléphones, WeChat et navigateurs)", "(1 MB = $1 bytes, igual que lo que muestran teléfonos, WeChat y navegadores)", "(1 MB = $1 byte, come mostrato da cellulari, WeChat e browser)", "(1 MB = $1 Bytes, wie Telefon, WeChat und Browser es anzeigen)", "(1 MB = $1 bytes, igual ao que celulares, WeChat e navegadores mostram)"),
]
# __PART2__

# —— 失败类：把旧的一条通配 pattern（动词作为 $1 会把中文带进译文）展开成逐动词 pattern ——
# (中文动词, en 动词, ja, ko, zh-TW, fr, es, it, de, pt)
FAILS = [
    ("更新", "update", "更新", "업데이트", "更新", "la mise à jour", "actualizar", "aggiornamento", "Aktualisieren", "atualizar"),
    ("新建", "create", "新規作成", "새로 만들기", "新增", "la création", "crear", "creazione", "Erstellen", "criar"),
    ("重命名", "rename", "名前変更", "이름 바꾸기", "重新命名", "le renommage", "renombrar", "rinomina", "Umbenennen", "renomear"),
    ("删除", "delete", "削除", "삭제", "刪除", "la suppression", "eliminar", "eliminazione", "Löschen", "excluir"),
    ("导入", "import", "取り込み", "가져오기", "匯入", "l’importation", "importar", "importazione", "Importieren", "importar"),
    ("生成模板", "template creation", "テンプレート生成", "템플릿 생성", "產生範本", "la création du modèle", "generar la plantilla", "creazione del modello", "Vorlagenerstellung", "gerar o modelo"),
    ("设计保存", "design save", "デザイン保存", "디자인 저장", "設計儲存", "l’enregistrement du design", "guardar el diseño", "salvataggio design", "Design speichern", "salvar o design"),
    ("间距保存", "spacing save", "余白保存", "간격 저장", "間距儲存", "l’enregistrement de l’espacement", "guardar el espaciado", "salvataggio spaziatura", "Abstand speichern", "salvar o espaçamento"),
    ("媒体设置保存", "media settings save", "メディア設定保存", "미디어 설정 저장", "媒體設定儲存", "l’enregistrement des réglages de médias", "guardar los ajustes de medios", "salvataggio impostazioni media", "Medieneinstellungen speichern", "salvar as configurações de mídia"),
    ("图片保存", "image save", "画像保存", "이미지 저장", "圖片儲存", "l’enregistrement de l’image", "guardar la imagen", "salvataggio immagine", "Bild speichern", "salvar a imagem"),
    ("图片位置保存", "image position save", "画像位置保存", "이미지 위치 저장", "圖片位置儲存", "l’enregistrement de la position d’image", "guardar la posición de la imagen", "salvataggio posizione immagine", "Bildposition speichern", "salvar a posição da imagem"),
    ("区块顺序保存", "block order save", "ブロック順序保存", "블록 순서 저장", "區塊順序儲存", "l’enregistrement de l’ordre des sections", "guardar el orden de secciones", "salvataggio ordine sezioni", "Blockreihenfolge speichern", "salvar a ordem das seções"),
    ("体检", "permission check", "チェック", "점검", "體檢", "la vérification", "la comprobación", "verifica", "Prüfung", "a verificação"),
    ("打包", "packing", "パック", "패키징", "打包", "l’empaquetage", "empaquetar", "packaging", "Packen", "empacotar"),
    ("发布", "publish", "公開", "게시", "發布", "la publication", "publicar", "pubblicazione", "Veröffentlichen", "publicar"),
    ("保存", "save", "保存", "저장", "儲存", "l’enregistrement", "guardar", "salvataggio", "Speichern", "salvar"),
]

def main():
    EXTRA = {
        48: ("發布失敗", "Échec de la publication", "Error al publicar", "Pubblicazione non riuscita", "Veröffentlichen fehlgeschlagen", "Falha ao publicar"),
        49: ("有未儲存的修改：$1。", "Modifications non enregistrées : $1.", "Cambios sin guardar: $1.", "Modifiche non salvate: $1.", "Nicht gespeicherte Änderungen: $1.", "Alterações não salvas: $1."),
        50: ("：$1。點上方「保留」存下畫布調整；要更新到公開版請回作品集點右上角「發布」。", " : $1. Cliquez « Conserver » ci-dessus pour garder vos ajustements ; pour la version publique, retournez au portfolio et cliquez « Publier » en haut à droite.", ": $1. Pulsa «Conservar» arriba para guardar tus ajustes; para la versión pública, vuelve al portafolio y pulsa «Publicar» arriba a la derecha.", ": $1. Premi «Conserva» sopra per salvare le modifiche; per la versione pubblica torna al portfolio e premi «Pubblica» in alto a destra.", ": $1. Oben „Behalten“ klicken, um die Anpassungen zu sichern; für die öffentliche Version zurück zum Portfolio und oben rechts „Veröffentlichen“.", ": $1. Clique «Manter» acima para salvar os ajustes; para a versão pública, volte ao portfólio e clique «Publicar» no canto superior direito."),
        51: ("請先在畫布中選取要展開的區塊、分類或專案；全部展開請使用頂部按鈕", "Sélectionnez d’abord une section, une catégorie ou un projet sur le canevas ; utilisez le bouton du haut pour tout déplier", "Selecciona primero un bloque, categoría o proyecto en el lienzo; usa el botón superior para desplegar todo", "Seleziona prima un blocco, una categoria o un progetto sulla tela; usa il pulsante in alto per espandere tutto", "Wähle zuerst einen Block / eine Kategorie / ein Projekt auf der Leinwand; zum Alles-Ausklappen die Taste oben nutzen", "Selecione primeiro um bloco, categoria ou projeto na tela; use o botão do topo para expandir tudo"),
        52: ("工具列裡的「每行 $1」", "Le bouton « par rangée $1 » de la barre d’outils", "El botón «por fila $1» de la barra de herramientas", "Il pulsante «per riga $1» della barra strumenti", "Die Taste „pro Reihe $1“ der Werkzeugleiste", "O botão «por linha $1» da barra de ferramentas"),
        53: ("已重新整理", "Actualisé", "Actualizado", "Aggiornato", "Aktualisiert", "Atualizado"),
        54: ("已復原", "Restauré", "Restaurado", "Ripristinato", "Wiederhergestellt", "Restaurado"),
        55: ("已保留", "Conservé", "Conservado", "Conservato", "Behalten", "Mantido"),
        56: ("已刪除", "Supprimé", "Eliminado", "Eliminato", "Gelöscht", "Excluído"),
        57: ("已調整順序", "Ordre modifié", "Orden ajustado", "Ordine modificato", "Reihenfolge angepasst", "Ordem ajustada"),
        58: ("文字已儲存", "Texte enregistré", "Texto guardado", "Testo salvato", "Text gespeichert", "Texto salvo"),
        59: ("已恢復預設文字", "Texte par défaut restauré", "Texto por defecto restaurado", "Testo predefinito ripristinato", "Standardtext wiederhergestellt", "Texto padrão restaurado"),
        60: ("已恢復預設尺寸", "Taille par défaut restaurée", "Tamaño por defecto restaurado", "Dimensione predefinita ripristinata", "Standardgröße wiederhergestellt", "Tamanho padrão restaurado"),
        61: ("已複製授權碼", "Code d’autorisation copié", "Código de autorización copiado", "Codice di autorizzazione copiato", "Autorisierungscode kopiert", "Código de autorização copiado"),
    }
    path = os.path.join(HERE, 'patterns.json')
    pats = json.load(io.open(path, encoding='utf-8'))
    # 幂等：只清掉上一轮插入的逐动词失败 pattern（按精确 src 集合，绝不误伤其它条目）
    inserted_srcs = {'^' + f[0] + '失败[：:](.*)$' for f in FAILS}
    pats = [p for p in pats if p.get('src') not in inserted_srcs]
    assert len(T) == len(pats), 'T=%d patterns=%d' % (len(T), len(pats))
    for i, (row, it) in enumerate(zip(T, pats)):
        if i == 47:
            continue   # 通配失败 pattern：在下方 fails 逻辑里单独处理
        if row is None:
            row = EXTRA.get(i)
            assert row, 'unfilled index %d' % i
        assert len(row) == 6, 'index %d col=%d' % (i, len(row))
        for l, v in zip(['zh-TW', 'fr', 'es', 'it', 'de', 'pt'], row):
            it[l] = v
    # 把通配失败 pattern 展开成逐动词 pattern，插到原 index 47 之前（原条目保留作兜底）
    generic = pats[47]
    for lang in ['zh-TW', 'fr', 'es', 'it', 'de', 'pt']:
        generic[lang] = '$1 failed: $2'   # 兜底；正常路径命不中（逐动词 pattern 在前）
    fails = []
    IT_ART = {'aggiornamento': 'l’aggiornamento', 'creazione': 'la creazione', 'rinomina': 'la rinomina',
              'eliminazione': 'l’eliminazione', 'importazione': 'l’importazione', 'creazione del modello': 'la creazione del modello',
              'salvataggio design': 'il salvataggio del design', 'salvataggio spaziatura': 'il salvataggio della spaziatura',
              'salvataggio impostazioni media': 'il salvataggio delle impostazioni media', 'salvataggio immagine': 'il salvataggio dell’immagine',
              'salvataggio posizione immagine': 'il salvataggio della posizione dell’immagine', 'salvataggio ordine sezioni': 'il salvataggio dell’ordine delle sezioni',
              'verifica': 'la verifica', 'packaging': 'il packaging', 'pubblicazione': 'la pubblicazione', 'salvataggio': 'il salvataggio'}
    PT_INF = {'update': 'atualizar', 'create': 'criar', 'rename': 'renomear', 'delete': 'excluir', 'import': 'importar',
              'template creation': 'gerar o modelo', 'design save': 'salvar o design', 'spacing save': 'salvar o espaçamento',
              'media settings save': 'salvar as configurações de mídia', 'image save': 'salvar a imagem',
              'image position save': 'salvar a posição da imagem', 'block order save': 'salvar a ordem das seções',
              'permission check': 'verificar', 'packing': 'empacotar', 'publish': 'publicar', 'save': 'salvar'}
    for verb, en, ja, ko, tw, fr, es, it_, de, pt in FAILS:
        fails.append({
            'src': '^' + verb + '失败[：:](.*)$',
            'en': en[0].upper() + en[1:] + ' failed: $1',
            'ja': ja + 'に失敗しました：$1',
            'ko': ko + ' 실패: $1',
            'zh-TW': tw + '失敗：$1',
            'fr': 'Échec de ' + fr + ' : $1',
            'es': 'Error al ' + es + ': $1',
            'it': 'Errore durante ' + IT_ART[it_] + ': $1',
            'de': de + ' fehlgeschlagen: $1',
            'pt': 'Falha ao ' + PT_INF[en] + ': $1',
        })
    pats = pats[:47] + fails + pats[47:]
    io.open(path, 'w', encoding='utf-8', newline='\n').write(
        json.dumps(pats, ensure_ascii=False, indent=1) + '\n')
    langs = ['en', 'ja', 'ko', 'zh-TW', 'fr', 'es', 'it', 'de', 'pt']
    need = {'src', 'en', 'ja', 'ko', 'zh-TW', 'fr', 'es', 'it', 'de', 'pt'}
    for it in pats:
        miss = need - set(it.keys())
        assert not miss, 'pattern 缺字段 %s: %s' % (miss, it['src'][:40])
    print('patterns:', len(pats), '条，全部', ','.join(langs), '字段齐备')

main()
