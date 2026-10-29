require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

// السماح بقراءة البيانات القادمة بصيغة JSON
app.use(express.json());

// تقديم الملفات الثابتة (الواجهة الأمامية للموقع) من نفس المجلد
app.use(express.static(path.join(__dirname)));

// 1. إعداد الاتصال بـ Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 2. إعداد الاتصال بقاعدة بيانات Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 3. إنشاء جدول المنتجات تلقائياً عند تشغيل السيرفر
async function initDB() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        price REAL NOT NULL,
        image_url TEXT,
        category TEXT
      )
    `);
    console.log("Database & Tables are ready! 🚀");
  } catch (err) {
    console.error("Error initializing database:", err);
  }
}
initDB();

// مسار افتراضي لاختبار أن السيرفر يعمل
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running successfully!' });
});

// مسار لجلب كل المنتجات من قاعدة بيانات Turso
app.get('/api/products', async (req, res) => {
  try {
    const result = await db.execute("SELECT * FROM products");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// مسار لإضافة منتج جديد (يستقبل العنوان، السعر، رابط الصورة من Cloudinary، والقسم)
app.post('/api/products', async (req, res) => {
  try {
    const { title, price, image_url, category } = req.body;
    
    if (!title || !price) {
      return res.status(400).json({ error: 'Title and price are required' });
    }

    await db.execute({
      sql: "INSERT INTO products (title, price, image_url, category) VALUES (?, ?, ?, ?)",
      args: [title, price, image_url || '', category || 'general']
    });

    res.json({ success: true, message: 'Product added successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add product' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});