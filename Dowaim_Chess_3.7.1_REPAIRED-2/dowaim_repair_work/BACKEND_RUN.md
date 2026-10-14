# تشغيل خادم White Nile Chess V1

## محليًا
داخل مجلد backend:
1. npm install
2. npm start
3. health: GET http://localhost:8080/health

## Docker
docker compose up --build

## WebSocket
ws://HOST:8080/ws?gameId=<GAME_ID>

## ملاحظات إنتاجية
- ضع HTTPS/WSS خلف reverse proxy.
- في الإصدار 3.7.1 تُستخدم PostgreSQL لحفظ لقطة حالة التطبيق كاملة عند ضبط DATABASE_URL، وتستخدم Redis للجلسات وحدود الطلبات. يلزم اختبار اتصال الخدمات قبل النشر.
- أضف JWT/OAuth ومصادقة البريد.
- لا تجعل العميل مصدر الحقيقة للنقلات؛ الخادم يتحقق منها.
- أضف محرك pairing حقيقي للـSwiss وكسر التعادل.
- أضف خدمة rating ومعاملات ذرية.
- أضف fair-play pipeline ومراجعة بشرية.
- أضف rate limiting وaudit logs ونسخ احتياطي.
