# Tip ladder catalog (draft for review)

Natural Hebrew. Per topic: add-ladder + mid tips on edit (update) and delete (remove).
Meetings live on tasks rows — tasks mutations also advance the meetings ladder.
Engine fires **one tip per turn**; mid unlocks after any basic in the topic was shown.

| order | key | topic | tier | op | text |
|------:|-----|-------|------|----|------|
| 100 | shopping_basic_add | shopping | basic | add | לידיעתך: אפשר פשוט לכתוב לי מה לקנות — למשל «תוסיפי חלב לקניות» — ואשמור את זה. |
| 101 | shopping_basic_show | shopping | basic | add | דרך אגב, בכל רגע אפשר לבקש «הציגי את הקניות» ואראה לך מה שמור. |
| 102 | shopping_mid_bought | shopping | intermediate | add | אפשר גם לכתוב «קניתי חלב» — ואוריד את זה מהקניות בשבילך. |
| 103 | shopping_mid_qty | shopping | intermediate | add | כדאי לנסות לציין כמות — למשל «עגבניות 2 ק״ג» — כדי שהקניות יהיו ברורות יותר. |
| 104 | shopping_adv_share | shopping | advanced | add | אני ממליצה: אפשר לשתף פריט מהקניות עם מישהו («תשתפי את החלב עם עמית»), או לשאול «מה אני צריך לקנות». |
| 105 | shopping_mid_edit | shopping | intermediate | update | דרך אגב, אפשר גם לשנות פריט שכבר שמור — למשל «תשני את החלב לשני ליטר» או לעדכן כמות. |
| 106 | shopping_mid_delete | shopping | intermediate | remove | לידיעתך: אפשר למחוק מהקניות במשפט — «תמחקי את החלב» — או לכתוב «קניתי חלב» כשכבר קנית. |
| 200 | tasks_basic_add | tasks | basic | add | לידיעתך: אפשר לבקש ממני מטלה במשפט — למשל «תוסיפי מטלה להתקשר לרופא». |
| 201 | tasks_basic_show | tasks | basic | add | דרך אגב, «הציגי את המטלות» מראה לך מה פתוח אצלי. |
| 202 | tasks_mid_done | tasks | intermediate | add | אפשר גם לכתוב «סיימתי להתקשר לרופא» — ואסמן או אסיר את המטלה בהתאם. |
| 203 | tasks_mid_when | tasks | intermediate | add | כדאי לנסות להוסיף מתי — «מטלה לפגישה מחר ב־10» — כדי שזה יופיע בזמן הנכון. |
| 204 | tasks_adv_standing | tasks | advanced | add | אני ממליצה: מטלה קבועה («כל שלישי חדר כושר») נשארת אצלי, ואפשר לחבר אליה תזכורת בוואטסאפ אם תרצה. |
| 205 | tasks_mid_edit | tasks | intermediate | update | אפשר גם לעדכן מטלה קיימת — «תשני את השם לפגישה עם עמית» או להזיז את השעה — בלי לפתוח מטלה חדשה. |
| 206 | tasks_mid_delete | tasks | intermediate | remove | לידיעתך: כשרוצים להסיר לגמרי — «תמחקי את המטלה להתקשר לרופא». לסימון שסיימת להפעם עדיף «סיימתי…». |
| 700 | meetings_basic_slot | meetings | basic | add | לידיעתך: אפשר לשמור פגישה במשפט — למשל «שמור פגישה עם טל ביום ראשון ב־10» — ואשים אותה ביומן. |
| 701 | meetings_basic_ask | meetings | basic | add | דרך אגב, אפשר לשאול «מה יש לי מחר?» ואראה את הפגישות והמטלות לאותו יום. |
| 702 | meetings_mid_duration | meetings | intermediate | add | אפשר גם לציין משך — «פגישה מ־10 עד 12» או «מ־10 למשך שעתיים» — ואשמור גם את שעת הסיום. |
| 703 | meetings_mid_allday | meetings | intermediate | add | כדאי לנסות פגישה של יום שלם — «פגישה מחר יום שלם» או חופשה מכמה ימים — בלי לבחור שעה. |
| 704 | meetings_adv_series | meetings | advanced | add | אני ממליצה: סדרה קבועה — «פגישת צוות כל שלישי ב־10» — נשמרת ככלל אחד, ואפשר גם לבטל או להזיז רק מופע אחד. |
| 705 | meetings_mid_edit | meetings | intermediate | update | דרך אגב, אפשר להזיז פגישה קיימת — «תעבירי את הפגישה עם טל ל־11» — בלי לפתוח פגישה חדשה. |
| 706 | meetings_mid_occurrence | meetings | intermediate | update | לידיעתך: בסדרה קבועה אפשר לגעת רק במופע אחד — «ב־23.10 אני לא צריך לאסוף» או «בשישי הקרוב ב־11» — בלי לשנות את כל הכלל. |
| 707 | meetings_mid_delete | meetings | intermediate | remove | אפשר גם למחוק פגישה לגמרי — «תמחקי את הפגישה עם טל». בסדרה: מחיקה מסירה את הכלל; לביטול פעם אחת עדיף לבטל רק את אותו מופע. |
| 300 | custom_basic_named | custom | basic | add | לידיעתך: אפשר לפתוח אוסף בשם — למשל «תוסיפי לבעיות לבדוק שרת» — ואשמור שם את הפריטים. |
| 301 | custom_basic_show | custom | basic | add | דרך אגב, אפשר לבקש «הציגי את בעיות» (או השם שבחרת) ואראה מה יש שם. |
| 302 | custom_mid_more | custom | intermediate | add | אפשר גם להוסיף עוד פריטים לאותו אוסף במשפט הבא — בלי לפתוח משהו חדש. |
| 303 | custom_mid_share | custom | intermediate | add | כדאי לנסות לשתף אוסף עם מישהו — «תשתפי את בעיות עם עמית» — כדי שתראו את אותו דבר. |
| 304 | custom_adv_event | custom | advanced | add | אני ממליצה: כשמתארגנים לערב (פוקר, יום הולדת, קולנוע) אפשר לחבר אליו רשימות מתאימות לאירוע — ואנהל את זה יחד עם המטלה של האירוע. |
| 305 | custom_mid_edit | custom | intermediate | update | דרך אגב, אפשר לעדכן פריט באוסף — «תשני בבעיות את לבדוק שרת ללבדוק פרודקשן». |
| 306 | custom_mid_delete | custom | intermediate | remove | כדאי לנסות למחוק פריט ספציפי בשם — «מחקתי לבדוק שרת מבעיות» — בלי למחוק את כל האוסף. |
| 400 | filing_basic_what | filing | basic | add | לידיעתך: תיוק שומר עובדה קבועה — כתובת, קוד, העדפה — לא משהו לקנות או לעשות היום. |
| 401 | filing_basic_ask | filing | basic | add | דרך אגב, אפשר לבקש «הציגי תיוקים» ואראה מה שמרנו. |
| 402 | filing_mid_media | filing | intermediate | add | אפשר גם לתייק תמונה, וידאו או קובץ — פשוט שלח/י ואגיד לאן לשמור. |
| 403 | filing_mid_update | filing | intermediate | add | כדאי לנסות לעדכן תיוק קיים במשפט — «תעדכני שהכתובת השתנתה ל…» — בלי לפתוח כפילות. |
| 404 | filing_adv_share_nav | filing | advanced | add | אני ממליצה: אפשר לשתף תיוק עם מישהו, ועל כתובת שתייקת אוכל גם להציע ניווט ב־Waze. |
| 405 | filing_mid_edit_op | filing | intermediate | update | לידיעתך: אחרי שתייקת משהו, אפשר לעדכן אותו במשפט — «תעדכני את הכתובת ל…» — ואחליף את מה ששמור. |
| 406 | filing_mid_delete | filing | intermediate | remove | אפשר גם למחוק תיוק שלא רלוונטי — «תמחקי את קוד הכניסה לאימייל» — ואסיר אותו. |
| 500 | reminders_basic_store | reminders | basic | add | לידיעתך: התזכורות נשמרות אצלי, וכל פעם שתרצה אוכל להציג אותן. |
| 501 | reminders_basic_ask | reminders | basic | add | דרך אגב, «הציגי תזכורות» מראה את מה שעדיין פעיל. |
| 502 | reminders_mid_relative | reminders | intermediate | add | אפשר גם «תזכירי לי בעוד שעה לשתות מים» — בלי לבחור שעה מדויקת מראש. |
| 503 | reminders_mid_exact | reminders | intermediate | add | כדאי לנסות שעה מדויקת — «תזכירי לי מחר ב־9 לקנות חלב». |
| 504 | reminders_adv_repeat | reminders | advanced | add | אני ממליצה: אפשר תזכורת חוזרת («כל שלישי ב־19») ולחבר אותה למטלה קבועה אם בא לך. |
| 505 | reminders_mid_edit | reminders | intermediate | update | דרך אגב, אפשר להזיז תזכורת קיימת — «תעבירי את התזכורת לשתות מים ל־21:00» — בלי ליצור חדשה. |
| 506 | reminders_mid_delete | reminders | intermediate | remove | לידיעתך: «תבטלי את התזכורת לשתות מים» עוצרת אותה אצלי — ואפשר תמיד לקבוע מחדש אחר כך. |
| 600 | directory_basic_add | directory | basic | add | לידיעתך: אפשר לשמור איש קשר אצלי — «תוסיפי את מיכל 050…» — ואז אוכל לשלוח בשמה. |
| 601 | directory_basic_show | directory | basic | add | דרך אגב, «הציגי אנשי קשר» מראה מי שמור בספר הטלפונים. |
| 602 | directory_mid_send | directory | intermediate | add | אפשר גם לבקש «תשלחי למיכל שאגיע באיחור» — בלי להקליד שוב את המספר. |
| 603 | directory_mid_update | directory | intermediate | add | כדאי לנסות לעדכן מספר קיים במשפט — «תעדכני את הטלפון של מיכל ל…». |
| 604 | directory_adv_share | directory | advanced | add | אני ממליצה: אפשר לשתף איש קשר או את ספר הטלפונים עם מישהו מהצוות, כשזה מתאים. |
| 605 | directory_mid_edit_op | directory | intermediate | update | אפשר גם לתקן פרטים שכבר שמורים — «תעדכני את הטלפון של מיכל ל…» — ואחליף במקום. |
| 606 | directory_mid_delete | directory | intermediate | remove | כדאי לנסות למחוק איש קשר שלא צריך — «תמחקי את מיכל מאנשי הקשר» — ואסיר אותו מהספר. |
| 50 | guest_terms | guest | basic | — | לידיעתך (תמצית): כאורח אפשר בעיקר לצפות במה ששותף איתך ולהירשם בוואטסאפ עם שם ולשון פנייה (זכר/נקבה). אחרי ההרשמה תקבל/י חשבון משלך עם לוסי — בלי שם משתמש או סיסמה. |

Source: `backend/src/services/tip-catalog.ts`.
