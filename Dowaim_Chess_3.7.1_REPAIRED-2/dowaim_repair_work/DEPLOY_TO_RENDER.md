# نشر White Nile Chess على Render

## ما تم تجهيزه
- Web Service واحد يشغل Express ويخدم واجهة المتصفح والـAPI من نفس العنوان.
- WebSocket على `/ws`.
- `/health` و`/ready` لفحص الحالة.
- Render Blueprint في `render.yaml` ينشئ Web Service + Postgres + Key Value.

## النشر
1. ارفع محتويات هذه الحزمة إلى مستودع GitHub (وليس ملف ZIP فقط).
2. في Render اختر New → Blueprint ثم اختر المستودع.
3. وافق على إنشاء الموارد المعرفة في `render.yaml`.
4. انتظر نجاح الـDeploy.
5. افتح رابط الخدمة `https://white-nile-chess.onrender.com` أو الرابط الذي يعرضه Render إذا كان الاسم متاحًا.
6. يجب أن تعطي `/health` استجابة JSON وبأن تعطي `/ready` حالة 200 بعد اتصال Redis وPostgres.

## ملاحظة مهمة
لا تُعلن المنصة جاهزة للاستخدام العام قبل اختبار حسابين ومباراة WebSocket وتسجيل النتيجة والبطولات وTeam Arena عمليًا بعد النشر.
