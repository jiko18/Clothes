const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// السماح بقراءة البيانات القادمة بصيغة JSON
app.use(express.json());

// تقديم الملفات الثابتة (الواجهة الأمامية للموقع) من نفس المجلد
app.use(express.static(path.join(__dirname)));

// مسار افتراضي لاختبار أن السيرفر يعمل
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running successfully!' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
