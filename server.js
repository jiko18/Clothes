require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');
const cloudinary = require('cloudinary').v2;
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// 1) Middleware & Config
// ============================================================
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/async function sanitizeStaleOldRefs() {
  console.log('🧹 Sanitizing stale _old references...');

  // 0) تعطيل FKs أثناء إعادة البناء
  try { await db.execute('PRAGMA foreign_keys=OFF'); } catch (_) {}

  // 1) تشخيص
  try {
    const all = await db.execute(
      "SELECT type, name, sql FROM sqlite_master WHERE sql LIKE '%\\_old%' ESCAPE '\\'"
    );
    if (all.rows.length > 0) {
      console.log(`⚠️ Found ${all.rows.length} object(s) with _old reference:`);
      for (const r of all.rows) console.log(`   [${r.type}] ${r.name}`);
    } else {
      console.log('   ✓ No _old references in schema');
    }
  } catch (e) { console.error('   diagnostic failed:', e.message); }

  // 2) حذف triggers/views/indexes
  try {
    const unsafe = await db.execute(
      "SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view','index') AND sql LIKE '%\\_old%' ESCAPE '\\'"
    );
    for (const r of unsafe.rows) {
      try {
        if (r.type === 'trigger') await db.execute(`DROP TRIGGER IF EXISTS "${r.name}"`);
        else if (r.type === 'view') await db.execute(`DROP VIEW IF EXISTS "${r.name}"`);
        else if (r.type === 'index') await db.execute(`DROP INDEX IF EXISTS "${r.name}"`);
        console.log(`🧹 Dropped ${r.type}: ${r.name}`);
      } catch (e) { console.error(`   Drop ${r.name}:`, e.message); }
    }
  } catch (e) {}

  // 3) إعادة بناء الجداول التي تحتوي FK إلى _old
  try {
    const tables = await db.execute(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%\\_old%' ESCAPE '\\'"
    );
    for (const t of tables.rows) {
      if (t.name.endsWith('_old')) continue;

      console.log(`🔧 Rebuilding "${t.name}"...`);

      // ✅ النمط يشمل ON DELETE / ON UPDATE بعد REFERENCES
      const ON_CLAUSE = '(?:\\s+ON\\s+(?:DELETE|UPDATE)\\s+(?:CASCADE|SET\\s+NULL|SET\\s+DEFAULT|RESTRICT|NO\\s+ACTION))?';

      const fkStandalone = new RegExp(
        `,\\s*FOREIGN\\s+KEY\\s*\\([^)]*\\)\\s*REFERENCES\\s+["']?\\w+_old["']?\\s*\\([^)]*\\)${ON_CLAUSE}`,
        'gi'
      );
      const fkInline = new RegExp(
        `\\s+REFERENCES\\s+["']?\\w+_old["']?\\s*\\([^)]*\\)${ON_CLAUSE}`,
        'gi'
      );

      let cleaned = t.sql.replace(fkStandalone, '').replace(fkInline, '');

      // Fallback: احذف كل الـ FKs إذا بقي أي _old
      if (/_old/i.test(cleaned)) {
        console.log(`   ⚠️ Fallback: removing ALL FKs from "${t.name}"`);
        cleaned = t.sql.replace(
          /,\s*FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+[^,()]+(?:\s*\([^)]*\))?(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION))?/gi,
          ''
        );
      }

      // إزالة أي فاصلة معلقة قبل قوس الإغلاق
      cleaned = cleaned.replace(/,\s*\)/g, ')');

      if (cleaned === t.sql) {
        console.log(`   ⚠️ No removable FK found — skipping`);
        continue;
      }

      const tmpName = `__san_${t.name}_${Date.now()}`;
      const nameEsc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const newSql = cleaned.replace(
        new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`]?${nameEsc}["'\`]?`, 'i'),
        `CREATE TABLE "${tmpName}"`
      );

      try {
        await db.execute(`DROP TABLE IF EXISTS "${tmpName}"`);
        await db.execute(newSql);

        const oc = await db.execute(`PRAGMA table_info("${t.name}")`);
        const nc = await db.execute(`PRAGMA table_info("${tmpName}")`);
        const oldNames = oc.rows.map(c => c.name);
        const newNames = nc.rows.map(c => c.name);
        const shared = oldNames.filter(n => newNames.includes(n));

        if (shared.length > 0) {
          const cols = shared.map(c => `"${c}"`).join(', ');
          await db.execute(`INSERT INTO "${tmpName}" (${cols}) SELECT ${cols} FROM "${t.name}"`);
        }

        await db.execute(`DROP TABLE "${t.name}"`);
        await db.execute(`ALTER TABLE "${tmpName}" RENAME TO "${t.name}"`);
        console.log(`   ✅ Rebuilt "${t.name}"`);
      } catch (e) {
        console.error(`   ❌ Rebuild failed:`, e.message);
        try { await db.execute(`DROP TABLE IF EXISTS "${tmpName}"`); } catch (_) {}
      }
    }
  } catch (e) { console.error('   table rebuild:', e.message); }

  // 4) حذف جداول _old المتبقية
  try {
    const oldTables = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%\\_old' ESCAPE '\\'"
    );
    for (const r of oldTables.rows) {
      try {
        await db.execute(`DROP TABLE IF EXISTS "${r.name}"`);
        console.log(`🧹 Dropped orphan _old table: ${r.name}`);
      } catch (e) { console.error(`   Drop ${r.name}:`, e.message); }
    }
  } catch (e) {}

  // 5) إعادة تشغيل FKs
  try { await db.execute('PRAGMA foreign_keys=ON'); } catch (_) {}

  console.log('✅ Sanitization complete');
}

// ============================================================
// 2) Database Init
// ============================================================
async function initDB() {
  console.log('🔄 Initializing database...');

  // ✅ خطوة 1: إصلاح المراجع المعطوبة (يجب أن تكون أولاً)
  await sanitizeStaleOldRefs();

  // ---------- migrations القديمة ----------
  try {
    const oldCheck = await db.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='products'"
    );
    if (oldCheck.rows.length > 0 && oldCheck.rows[0].sql.includes('title TEXT')) {
      console.log('⚠️ Old products table detected → dropping...');
      await db.execute('DROP TABLE IF EXISTS products');
    }
  } catch (_) {}

  try {
    const check = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_prices'");
    if (check.rows.length > 0 && (check.rows[0].sql.includes("'express'") || check.rows[0].sql.includes("is_default") || !check.rows[0].sql.includes("wilaya TEXT NOT NULL"))) {
      console.log('🔄 Rebuilding delivery_prices...');
      await db.execute('DROP TABLE IF EXISTS delivery_prices');
    }
  } catch (e) { console.error('delivery_prices migration error:', e.message); }

  // users migration (بدون استخدام RENAME — لإبقاء FKs سليمة)
  try {
    const check = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
    if (check.rows.length > 0 && check.rows[0].sql.includes("'manager'")) {
      console.log('🔄 Migrating users table (removing manager role)...');
      await db.execute('PRAGMA foreign_keys=off');
      await db.execute('DROP TABLE IF EXISTS users_new');
      await db.execute(`CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
        is_active INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      await db.execute(`INSERT INTO users_new (id, username, email, password_hash, full_name, role, is_active, last_login_at, created_at, updated_at)
        SELECT id, username, email, password_hash, full_name,
        CASE WHEN role = 'manager' THEN 'staff' ELSE role END,
        is_active, last_login_at, created_at, updated_at FROM users`);
      await db.execute('DROP TABLE users');
      await db.execute('ALTER TABLE users_new RENAME TO users');
      await db.execute('PRAGMA foreign_keys=on');
      console.log('✅ users table migrated');
    }
  } catch (e) { console.error('users migration error:', e.message); }

  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      ip_address TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      phone2 TEXT,
      email TEXT,
      password_hash TEXT,
      wilaya TEXT NOT NULL,
      municipality TEXT NOT NULL,
      address TEXT NOT NULL,
      total_orders INTEGER NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      category TEXT NOT NULL,
      category_label TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT 'both' CHECK(gender IN ('girls','boys','both')),
      price REAL NOT NULL CHECK(price >= 0),
      old_price REAL,
      badge TEXT,
      badge_type TEXT DEFAULT 'new',
      badge_color TEXT DEFAULT '#feca57',
      badge_color_name TEXT DEFAULT 'أصفر فاتح',
      description TEXT,
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_set INTEGER NOT NULL DEFAULT 0,
      views_count INTEGER NOT NULL DEFAULT 0,
      sales_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
       `CREATE TABLE IF NOT EXISTS product_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      hex TEXT NOT NULL DEFAULT '#cccccc',
      combo_name TEXT,
      part_label TEXT,
      combo_available_ages TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS product_color_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      color_id INTEGER NOT NULL,
      media_url TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'image' CHECK(media_type IN ('image','video')),
      is_main INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (color_id) REFERENCES product_colors(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS product_ages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      age_label TEXT NOT NULL,
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS product_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      detail_text TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone1 TEXT NOT NULL,
      phone2 TEXT,
      wilaya TEXT NOT NULL,
      municipality TEXT NOT NULL,
      address TEXT NOT NULL,
      delivery_method TEXT NOT NULL DEFAULT 'home' CHECK(delivery_method IN ('home','agency')),
      delivery_cost REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      coupon_code TEXT,
      total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','out_for_delivery','delivered','cancelled')),
      notes TEXT,
      admin_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      color_name TEXT,
      color_hex TEXT,
      age_label TEXT,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
      unit_price REAL NOT NULL,
      total_price REAL NOT NULL,
      product_image TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS order_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      changed_by_user_id INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS theme_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS delivery_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_type TEXT NOT NULL CHECK(delivery_type IN ('home','agency')),
      wilaya TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(delivery_type, wilaya)
    )`,
    `CREATE TABLE IF NOT EXISTS wilayas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code INTEGER UNIQUE,
      name TEXT NOT NULL UNIQUE
    )`,
    `CREATE TABLE IF NOT EXISTS municipalities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wilaya_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY (wilaya_id) REFERENCES wilayas(id) ON DELETE CASCADE,
      UNIQUE(wilaya_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS wishlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      session_token TEXT,
      product_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      customer_id INTEGER,
      customer_name TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      comment TEXT,
      is_approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('percent','fixed')),
      value REAL NOT NULL,
      min_order_amount REAL DEFAULT 0,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS carts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      session_token TEXT,
      product_id INTEGER NOT NULL,
      color_id INTEGER,
      age_label TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (color_id) REFERENCES product_colors(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      related_order_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (related_order_id) REFERENCES orders(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS deleted_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT,
      item_data TEXT NOT NULL,
      deleted_by_user_id INTEGER,
      deleted_by_username TEXT,
      deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      description TEXT,
      data TEXT NOT NULL,
      item_counts TEXT,
      created_by_user_id INTEGER,
      created_by_username TEXT,
      is_auto INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      action TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const sql of tables) {
    try { await db.execute(sql); }
    catch (err) { console.error('❌ Table creation error:', err.message); }
  }

  try {
    await db.execute("DELETE FROM delivery_prices WHERE delivery_type = 'express'");
  } catch(e) {}

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_sessions_token         ON sessions(token)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user          ON sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_phone        ON customers(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_products_category      ON products(category)`,
    `CREATE INDEX IF NOT EXISTS idx_products_gender        ON products(gender)`,
    `CREATE INDEX IF NOT EXISTS idx_product_colors_product ON product_colors(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_pci_color              ON product_color_images(color_id)`,
    `CREATE INDEX IF NOT EXISTS idx_product_ages_product   ON product_ages(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_product_details_product ON product_details(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status          ON orders(status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_customer        ON orders(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_phone           ON orders(phone1)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_created         ON orders(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_order      ON order_items(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_product    ON order_items(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_osh_order              ON order_status_history(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_municipalities_wilaya  ON municipalities(wilaya_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wishlist_customer      ON wishlist(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reviews_product        ON reviews(product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user     ON notifications(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_delivery_type_wilaya   ON delivery_prices(delivery_type, wilaya)`,
    `CREATE INDEX IF NOT EXISTS idx_deleted_items_type     ON deleted_items(item_type)`,
    `CREATE INDEX IF NOT EXISTS idx_deleted_items_date     ON deleted_items(deleted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_backups_date           ON backups(created_at)`,
  ];
  for (const sql of indexes) {
    try { await db.execute(sql); } catch (err) { console.error('Index err:', err.message); }
  }

  const wilayasList = [
    [1,'أدرار'],[2,'الشلف'],[3,'الأغواط'],[4,'أم البواقي'],[5,'باتنة'],
    [6,'بجاية'],[7,'بسكرة'],[8,'بشار'],[9,'البليدة'],[10,'البويرة'],
    [11,'تمنراست'],[12,'تبسة'],[13,'تلمسان'],[14,'تيارت'],[15,'تيزي وزو'],
    [16,'الجزائر'],[17,'الجلفة'],[18,'جيجل'],[19,'سطيف'],[20,'سعيدة'],
    [21,'سكيكدة'],[22,'سيدي بلعباس'],[23,'عنابة'],[24,'قالمة'],[25,'قسنطينة'],
    [26,'المدية'],[27,'مستغانم'],[28,'المسيلة'],[29,'معسكر'],[30,'ورقلة'],
    [31,'وهران'],[32,'البيض'],[33,'إليزي'],[34,'برج بوعريريج'],[35,'بومرداس'],
    [36,'الطارف'],[37,'تندوف'],[38,'تيسمسيلت'],[39,'الوادي'],[40,'خنشلة'],
    [41,'سوق أهراس'],[42,'تيبازة'],[43,'ميلة'],[44,'عين الدفلى'],[45,'النعامة'],
    [46,'عين تموشنت'],[47,'غرداية'],[48,'غليزان'],[49,'تيميمون'],[50,'برج باجي مختار'],
    [51,'أولاد جلال'],[52,'بني عباس'],[53,'عين صالح'],[54,'عين قزام'],[55,'تقرت'],
    [56,'جانت'],[57,'المغير'],[58,'المنيعة'],
  ];
  for (const [code, name] of wilayasList) {
    try {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO wilayas (code, name) VALUES (?, ?)',
        args: [code, name]
      });
    } catch (_) {}
  }

  for (const [name, value] of [
    ['primary', '#ff6b81'],
    ['primaryDark', '#e8556d'],
    ['secondary', '#6c5ce7'],
    ['accent', '#feca57'],
  ]) {
    try {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO theme_colors (name, color_value) VALUES (?, ?)',
        args: [name, value]
      });
    } catch (_) {}
  }

  const settingsSeeds = [
    ['storeName', 'بيبي شوب'],
    ['phone', '0550 00 00 00'],
    ['email', 'contact@babyshop.dz'],
    ['address', 'الجزائر العاصمة، الجزائر'],
    ['facebook', '#'], ['instagram', '#'], ['tiktok', '#'], ['whatsapp', '#'],
    ['topBarText', 'توصيل لجميع الولايات | الدفع عند الاستلام '],
    ['searchPlaceholder', 'ابحث عن ملابس، أحذية، إكسسوارات...'],
    ['footerCopyright', '© 2025 بيبي شوب - جميع الحقوق محفوظة'],
    ['telegramBotToken', ''],
    ['telegramChatId', ''],
    ['logo', ''],
  ];
  for (const [k, v] of settingsSeeds) {
    try {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
        args: [k, v]
      });
    } catch (_) {}
  }

  console.log('✅ Database & Tables are ready! 🚀');
}

// ============================================================
// 3) Helpers
// ============================================================
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function logAction(username, action, details) {
  try {
    await db.execute({
      sql: 'INSERT INTO audit_logs (username, action, details) VALUES (?, ?, ?)',
      args: [username, action, details]
    });
  } catch (e) { console.error('Audit Log error:', e.message); }
}

async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing auth token' });

    const result = await db.execute({
      sql: `SELECT s.user_id, s.expires_at, u.username, u.role, u.full_name
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token = ?`,
      args: [token]
    });

    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid token' });

    const session = result.rows[0];
    if (new Date(session.expires_at) < new Date()) {
      await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
      return res.status(401).json({ error: 'Session expired' });
    }

    req.user = session;
    req.token = token;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'هذه العملية تتطلب صلاحيات الأدمن' });
  }
  next();
}

async function uploadBase64ToCloudinary(dataUri, folder = 'babyshop/products') {
  if (!dataUri || typeof dataUri !== 'string') return dataUri;
  if (!dataUri.startsWith('data:')) return dataUri;
  try {
    const result = await cloudinary.uploader.upload(dataUri, {
      folder,
      resource_type: 'auto',
    });
    return result.secure_url;
  } catch (err) {
    console.error('❌ Cloudinary upload failed:', err.message);
    return dataUri;
  }
}

function isVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('data:video/') || /\.(mp4|webm|ogg|mov|avi|mkv|m4v)(\?|$)/i.test(url);
}

function escapeTelegram(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegramMessage(text, options = {}) {
  try {
    const tokenRes = await db.execute({
      sql: "SELECT value FROM settings WHERE key = 'telegramBotToken'", args: []
    });
    const chatRes = await db.execute({
      sql: "SELECT value FROM settings WHERE key = 'telegramChatId'", args: []
    });
    const token = tokenRes.rows[0]?.value;
    const chatId = chatRes.rows[0]?.value;

    if (!token || !chatId) {
      console.log('⚠️ Telegram not configured — skipped');
      return false;
    }

    const MAX_LEN = 4000;
    const chunks = [];
    if (text.length <= MAX_LEN) {
      chunks.push(text);
    } else {
      let remaining = text;
      while (remaining.length > 0) {
        let cut = Math.min(MAX_LEN, remaining.length);
        if (cut < remaining.length) {
          const lastNL = remaining.lastIndexOf('\n', cut);
          if (lastNL > MAX_LEN * 0.4) cut = lastNL;
        }
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
    }
    console.log(`📤 Sending Telegram message (${chunks.length} chunk(s), ${text.length} chars)`);

    let allOk = true;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const useHtml = options.parseMode !== false;
      const payload = { chat_id: chatId, text: chunk, disable_web_page_preview: true };
      if (useHtml) payload.parse_mode = 'HTML';
      
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      
      if (!result.ok) {
        console.error(`❌ Telegram API error (chunk ${i+1}/${chunks.length}):`, result.description);
        if (useHtml) {
          console.log('🔄 Retrying without HTML parse_mode...');
          const plainText = chunk.replace(/<[^>]*>/g, '');
          const retryRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: plainText, disable_web_page_preview: true })
          });
          const retryResult = await retryRes.json();
          if (!retryResult.ok) {
            console.error('❌ Retry without HTML also failed:', retryResult.description);
            allOk = false;
          } else {
            console.log('✅ Telegram notification sent (plain text fallback)');
          }
        } else {
          allOk = false;
        }
      } else {
        console.log(`✅ Telegram notification sent (chunk ${i+1}/${chunks.length})`);
      }
    }
    return allOk;
  } catch (e) {
    console.error('❌ Telegram exception:', e.message);
    return false;
  }
}

// ============================================================
// TRASH & BACKUPS HELPERS
// ============================================================
async function saveToTrash(itemType, itemId, itemName, itemData, user) {
  try {
    await db.execute({
      sql: `INSERT INTO deleted_items (item_type, item_id, item_name, item_data, deleted_by_user_id, deleted_by_username)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        itemType,
        String(itemId),
        itemName || '',
        JSON.stringify(itemData),
        user?.user_id || null,
        user?.username || 'system'
      ]
    });
  } catch (e) { console.error('❌ saveToTrash error:', e.message); }
}

async function createBackup(name, user, isAuto = false) {
  const products = [];
  const productRows = await db.execute('SELECT id FROM products ORDER BY id');
  for (const row of productRows.rows) {
    const p = await getProductWithRelations(row.id);
    if (p) products.push(p);
  }

  const settingsRes = await db.execute('SELECT key, value FROM settings');
  const settings = {};
  for (const row of settingsRes.rows) settings[row.key] = row.value;

  const themeRes = await db.execute('SELECT name, color_value FROM theme_colors');
  const theme = {};
  for (const row of themeRes.rows) theme[row.name] = row.color_value;

  const deliveryRes = await db.execute('SELECT * FROM delivery_prices');
  const delivery = deliveryRes.rows;

  const usersRes = await db.execute(
    'SELECT id, username, email, full_name, role, is_active, created_at FROM users'
  );
  const users = usersRes.rows;

  const ordersRes = await db.execute({
    sql: "SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000",
    args: []
  });
  const orders = [];
  for (const o of ordersRes.rows) {
    const itemsRes = await db.execute({
      sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [o.id]
    });
    orders.push({ ...o, items: itemsRes.rows });
  }

  const backupData = {
    version: 2,
    createdAt: new Date().toISOString(),
    products, settings, theme, delivery, users, orders
  };

  const counts = {
    products: products.length,
    orders: orders.length,
    users: users.length
  };

  const result = await db.execute({
    sql: `INSERT INTO backups (name, description, data, item_counts, created_by_user_id, created_by_username, is_auto)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      name || `نسخة ${new Date().toLocaleString('ar-DZ')}`,
      '',
      JSON.stringify(backupData),
      JSON.stringify(counts),
      user?.user_id || null,
      user?.username || 'system',
      isAuto ? 1 : 0
    ]
  });

  console.log('✅ Backup created, id =', result.lastInsertRowid);
  return { id: Number(result.lastInsertRowid), counts };
}

async function maybeAutoBackup() {
  try {
    const lastRes = await db.execute({
      sql: "SELECT id, created_at FROM backups WHERE is_auto = 1 ORDER BY created_at DESC LIMIT 1",
      args: []
    });
    let shouldBackup = false;
    if (lastRes.rows.length === 0) {
      shouldBackup = true;
    } else {
      const lastDate = new Date(lastRes.rows[0].created_at);
      const hoursSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60);
      if (hoursSince >= 24) shouldBackup = true;
    }
    if (shouldBackup) {
      await createBackup('نسخة تلقائية', null, true);
      console.log('✅ Auto backup created');
      const autoBackups = await db.execute({
        sql: "SELECT id FROM backups WHERE is_auto = 1 ORDER BY created_at DESC",
        args: []
      });
      if (autoBackups.rows.length > 7) {
        for (let i = 7; i < autoBackups.rows.length; i++) {
          await db.execute({ sql: 'DELETE FROM backups WHERE id = ?', args: [autoBackups.rows[i].id] });
        }
      }
    }
  } catch (e) { console.error('Auto backup failed:', e.message); }
}

// ============================================================
// 4) Health
// ============================================================
app.get('/api/health', async (req, res) => {
  try { await db.execute('SELECT 1'); res.json({ status: 'ok', time: new Date().toISOString() }); }
  catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ============================================================
// 5) AUTH
// ============================================================
app.post('/api/auth/setup', async (req, res) => {
  try {
    const count = await db.execute('SELECT COUNT(*) as c FROM users');
    if (Number(count.rows[0].c) > 0) return res.status(400).json({ error: 'Setup already done' });
    const { username = 'admin', password, email, full_name } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const hash = await bcrypt.hash(password, 10);
    await db.execute({
      sql: `INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, 'admin')`,
      args: [username, email || null, hash, full_name || 'مدير المتجر']
    });
    res.json({ success: true, message: 'Admin account created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE username = ? AND is_active = 1', args: [username] });
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: `INSERT INTO sessions (user_id, token, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)`,
      args: [user.id, token, req.ip || '', req.headers['user-agent'] || '', expiresAt]
    });
    await db.execute({ sql: `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, args: [user.id] });
    await logAction(user.username, 'تسجيل دخول', 'تم تسجيل الدخول إلى لوحة التحكم');
    res.json({
      success: true, token, expiresAt,
      user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name, email: user.email }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try { await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [req.token] }); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json({ user: req.user }));

// ============================================================
// 5.b) USERS MANAGEMENT & LOGS
// ============================================================
app.get('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, username, email, full_name, role, is_active, last_login_at, created_at FROM users ORDER BY created_at ASC',
      args: []
    });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logs', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id/activity', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const userRes = await db.execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [id] });
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const username = userRes.rows[0].username;

    const logs = await db.execute({
      sql: 'SELECT * FROM audit_logs WHERE username = ? ORDER BY created_at DESC LIMIT 100',
      args: [username]
    });
    res.json(logs.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, role, full_name, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
    if (password.length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة (4 أحرف على الأقل)' });
    if (!['admin', 'staff'].includes(role)) return res.status(400).json({ error: 'دور غير صالح' });
    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
    if (existing.rows.length > 0) return res.status(400).json({ error: 'اسم المستخدم موجود مسبقاً' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.execute({
      sql: `INSERT INTO users (username, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)`,
      args: [username, email || null, hash, full_name || null, role]
    });
    await logAction(req.user.username, 'إضافة مستخدم', `تم إضافة المستخدم ${username} بدور ${role}`);
    res.json({ success: true, id: Number(result.lastInsertRowid) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.user_id) {
      const { role } = req.body;
      if (role && role !== 'admin') return res.status(400).json({ error: 'لا يمكنك تخفيض صلاحياتك الخاصة' });
    }
    const { role, full_name, email, is_active, password } = req.body;
    const updates = []; const args = [];
    if (role && ['admin','staff'].includes(role)) { updates.push('role = ?'); args.push(role); }
    if (full_name !== undefined) { updates.push('full_name = ?'); args.push(full_name || null); }
    if (email !== undefined) { updates.push('email = ?'); args.push(email || null); }
    if (is_active !== undefined) { updates.push('is_active = ?'); args.push(is_active ? 1 : 0); }
    if (password) {
      if (password.length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة' });
      const hash = await bcrypt.hash(password, 10);
      updates.push('password_hash = ?'); args.push(hash);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'لا توجد تغييرات' });
    updates.push("updated_at = datetime('now')");
    args.push(id);
    await db.execute({ sql: `UPDATE users SET ${updates.join(', ')} WHERE id = ?`, args });
    await logAction(req.user.username, 'تعديل مستخدم', `تم تعديل المستخدم رقم ${id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.user_id) return res.status(400).json({ error: 'لا يمكنك حذف حسابك الخاص' });
    const u = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
    if (u.rows.length > 0) {
      const uData = u.rows[0];
      await saveToTrash('user', id, uData.username, uData, req.user);
      await logAction(req.user.username, 'حذف مستخدم', `تم حذف المستخدم ${uData.username}`);
    }
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Telegram test
app.post('/api/telegram/test', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const tokenRes = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'telegramBotToken'", args: [] });
    const chatRes = await db.execute({ sql: "SELECT value FROM settings WHERE key = 'telegramChatId'", args: [] });
    const token = tokenRes.rows[0]?.value;
    const chatId = chatRes.rows[0]?.value;
    if (!token || !chatId) return res.status(400).json({ error: 'لم يتم تكوين بيانات تيليجرام بعد' });

    const telegramRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🧪 <b>رسالة تجريبية</b>\n\nإذا وصلتك هذه الرسالة، فإن إعدادات البوت تعمل بنجاح ✓\n\nستصلك إشعارات الطلبات الجديدة تلقائياً.',
        parse_mode: 'HTML'
      })
    });
    const result = await telegramRes.json();
    if (!telegramRes.ok || !result.ok) {
      return res.status(400).json({ error: result.description || 'رفض تيليجرام الطلب' });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 6) PRODUCTS
// ============================================================
async function getProductWithRelations(id) {
  const p = await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [id] });
  if (p.rows.length === 0) return null;
  const product = p.rows[0];

  const colorsRes = await db.execute({
    sql: 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY sort_order, id',
    args: [id]
  });
  const agesRes = await db.execute({
    sql: 'SELECT * FROM product_ages WHERE product_id = ? ORDER BY sort_order, id',
    args: [id]
  });
  const detailsRes = await db.execute({
    sql: 'SELECT * FROM product_details WHERE product_id = ? ORDER BY sort_order, id',
    args: [id]
  });

  const flatColors = [];
  for (const c of colorsRes.rows) {
    const imgs = await db.execute({
      sql: 'SELECT * FROM product_color_images WHERE color_id = ? ORDER BY is_main DESC, sort_order, id',
      args: [c.id]
    });
    const images = imgs.rows.map(r => r.media_url);
    const mainRow = imgs.rows.find(r => Number(r.is_main) === 1) || imgs.rows[0];

    let comboAvailableAges = [];
    if (c.combo_available_ages) {
      try { comboAvailableAges = JSON.parse(c.combo_available_ages); } catch(e) { comboAvailableAges = []; }
    }

    flatColors.push({
      id: c.id,
      name: c.name,
      hex: c.hex,
      comboName: c.combo_name || null,
      partLabel: c.part_label || null,
      comboAvailableAges,
      image: mainRow ? mainRow.media_url : '',
      images: images.length ? images : (mainRow ? [mainRow.media_url] : [''])
    });
  }

  const isSet = !!Number(product.is_set);
  let combos = null;
  if (isSet) {
    const comboMap = new Map();
    flatColors.forEach(c => {
      const key = c.comboName || 'المجموعة الأساسية';
      if (!comboMap.has(key)) {
        comboMap.set(key, {
          name: key,
          images: c.images,
          parts: [],
          availableAges: Array.isArray(c.comboAvailableAges) ? [...c.comboAvailableAges] : []
        });
      }
      comboMap.get(key).parts.push({
        label: c.partLabel || 'قطعة',
        name: c.name,
        hex: c.hex
      });
    });
    combos = Array.from(comboMap.values());
  }

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    category: product.category,
    categoryLabel: product.category_label,
    gender: product.gender,
    price: product.price,
    oldPrice: product.old_price,
    badge: product.badge,
    badgeType: product.badge_type,
    badgeColor: product.badge_color || '#feca57',
    badgeColorName: product.badge_color_name || 'أصفر فاتح',
    description: product.description,
    stockQuantity: product.stock_quantity,
    isActive: !!Number(product.is_active),
    hidden: !Number(product.is_active),
    isSet,
    combos,
    viewsCount: product.views_count,
    salesCount: product.sales_count,
    colors: flatColors,
    ages: agesRes.rows.map(a => a.age_label),
    details: detailsRes.rows.map(d => d.detail_text),
    createdAt: product.created_at,
    updatedAt: product.updated_at
  };
}

app.get('/api/products', async (req, res) => {
  try {
    const { category, gender, search, include_hidden } = req.query;
    let sql = 'SELECT id FROM products WHERE 1=1';
    const args = [];

    if (include_hidden !== '1') {
      sql += ' AND is_active = 1';
    }
    if (category && category !== 'all') { sql += ' AND category = ?'; args.push(category); }
    if (gender && gender !== 'all') { sql += " AND (gender = ? OR gender = 'both')"; args.push(gender); }
    if (search) { sql += ' AND (name LIKE ? OR category_label LIKE ?)'; args.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY created_at DESC';

    const result = await db.execute({ sql, args });
    const products = [];
    for (const row of result.rows) {
      const p = await getProductWithRelations(row.id);
      if (p) products.push(p);
    }
    res.json(products);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await getProductWithRelations(parseInt(req.params.id));
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await db.execute({ sql: 'UPDATE products SET views_count = views_count + 1 WHERE id = ?', args: [product.id] });
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function saveProductRelations(productId, colors, ages, details) {
  await db.execute({ sql: 'DELETE FROM product_colors WHERE product_id = ?', args: [productId] });
  await db.execute({ sql: 'DELETE FROM product_ages WHERE product_id = ?', args: [productId] });
  await db.execute({ sql: 'DELETE FROM product_details WHERE product_id = ?', args: [productId] });

  if (Array.isArray(colors)) {
    for (let ci = 0; ci < colors.length; ci++) {
      const c = colors[ci];
      if (!c || !c.name) continue;

      const comboAgesJson = Array.isArray(c.comboAvailableAges) && c.comboAvailableAges.length
        ? JSON.stringify(c.comboAvailableAges)
        : null;

      const colorRes = await db.execute({
        sql: 'INSERT INTO product_colors (product_id, name, hex, combo_name, part_label, combo_available_ages, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [productId, c.name, c.hex || '#cccccc', c.comboName || null, c.partLabel || null, comboAgesJson, ci]
      });
      const colorId = Number(colorRes.lastInsertRowid);
      let imgs = [];
      if (Array.isArray(c.images) && c.images.length) imgs = c.images.filter(Boolean);
      else if (c.image) imgs = [c.image];
      for (let ii = 0; ii < imgs.length; ii++) {
        const finalUrl = await uploadBase64ToCloudinary(imgs[ii], `babyshop/products/${productId}`);
        await db.execute({
          sql: `INSERT INTO product_color_images (color_id, media_url, media_type, is_main, sort_order) VALUES (?, ?, ?, ?, ?)`,
          args: [colorId, finalUrl, isVideoUrl(finalUrl) ? 'video' : 'image', ii === 0 ? 1 : 0, ii]
        });
      }
    }
  }

  if (Array.isArray(ages)) {
    for (let i = 0; i < ages.length; i++) {
      const label = typeof ages[i] === 'string' ? ages[i] : (ages[i]?.label || '');
      if (!label) continue;
      await db.execute({
        sql: 'INSERT INTO product_ages (product_id, age_label, sort_order) VALUES (?, ?, ?)',
        args: [productId, label, i]
      });
    }
  }

  if (Array.isArray(details)) {
    for (let i = 0; i < details.length; i++) {
      if (!details[i]) continue;
      await db.execute({
        sql: 'INSERT INTO product_details (product_id, detail_text, sort_order) VALUES (?, ?, ?)',
        args: [productId, details[i], i]
      });
    }
  }
}

app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const {
      name, category, categoryLabel, gender, price, oldPrice,
      badge, badgeType, badgeColor, badgeColorName, description,
      colors, ages, details, stockQuantity, isSet, hidden
    } = req.body;
    if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });

    const slug = (name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w\u0600-\u06FF-]/g, '') || 'product') + '-' + Date.now();
    const effectiveActive = hidden ? 0 : 1;

    const result = await db.execute({
      sql: `INSERT INTO products
        (name, slug, category, category_label, gender, price, old_price, badge, badge_type, badge_color, badge_color_name, description, stock_quantity, is_active, is_set)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        name, slug,
        category || 'winter',
        categoryLabel || category || 'شتوي',
        gender || 'both',
        Number(price),
        oldPrice ? Number(oldPrice) : null,
        badge || null,
        badgeType || 'new',
        badgeColor || '#feca57',
        badgeColorName || 'أصفر فاتح',
        description || '',
        Number(stockQuantity) || 0,
        effectiveActive,
        isSet ? 1 : 0
      ]
    });
    const id = Number(result.lastInsertRowid);
    await saveProductRelations(id, colors, ages, details);
    await logAction(req.user.username, 'إضافة منتج', `تم إضافة المنتج ${name}`);
    const product = await getProductWithRelations(id);
    res.json({ success: true, id, product });
  } catch (err) { console.error('POST /products:', err); res.status(500).json({ error: err.message }); }
});

app.put('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const {
      name, category, categoryLabel, gender, price, oldPrice,
      badge, badgeType, badgeColor, badgeColorName, description,
      colors, ages, details, stockQuantity, isActive, isSet, hidden
    } = req.body;

    const current = await db.execute({ sql: 'SELECT is_active FROM products WHERE id = ?', args: [id] });
    if (current.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    let effectiveActive;
    if (hidden !== undefined) {
      effectiveActive = hidden ? 0 : 1;
    } else if (isActive !== undefined) {
      effectiveActive = isActive ? 1 : 0;
    } else {
      effectiveActive = Number(current.rows[0].is_active);
    }

    await db.execute({
      sql: `UPDATE products SET
        name=?, category=?, category_label=?, gender=?, price=?, old_price=?,
        badge=?, badge_type=?, badge_color=?, badge_color_name=?, description=?, stock_quantity=?, is_active=?, is_set=?,
        updated_at=datetime('now') WHERE id=?`,
      args: [
        name, category, categoryLabel, gender, Number(price),
        oldPrice ? Number(oldPrice) : null,
        badge || null, badgeType || 'new',
        badgeColor || '#feca57', badgeColorName || 'أصفر فاتح',
        description || '',
        Number(stockQuantity) || 0,
        effectiveActive,
        isSet ? 1 : 0,
        id
      ]
    });

    await saveProductRelations(id, colors, ages, details);
    await logAction(req.user.username, 'تعديل منتج', `تم تعديل المنتج ${name}`);
    const product = await getProductWithRelations(id);
    res.json({ success: true, product });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const product = await getProductWithRelations(id);
    if (product) {
      await saveToTrash('product', id, product.name, product, req.user);
      await logAction(req.user.username, 'حذف منتج', `تم حذف المنتج ${product.name}`);
    }
    await db.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 7) ORDERS
// ============================================================
app.post('/api/orders', async (req, res) => {
  try {
    const {
      firstName, lastName, phone1, phone2, wilaya, municipality, address,
      deliveryMethod, deliveryCost, items, notes
    } = req.body;

    if (!firstName || !lastName || !phone1 || !wilaya || !municipality || !address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    let customerId = null;
    const existingCust = await db.execute({ sql: 'SELECT id FROM customers WHERE phone = ?', args: [phone1] });
    if (existingCust.rows.length > 0) {
      customerId = existingCust.rows[0].id;
      await db.execute({
        sql: `UPDATE customers SET first_name=?, last_name=?, phone2=?, wilaya=?, municipality=?, address=?, updated_at=datetime('now') WHERE id=?`,
        args: [firstName, lastName, phone2 || null, wilaya, municipality, address, customerId]
      });
    } else {
      const custRes = await db.execute({
        sql: `INSERT INTO customers (first_name, last_name, phone, phone2, wilaya, municipality, address) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [firstName, lastName, phone1, phone2 || null, wilaya, municipality, address]
      });
      customerId = Number(custRes.lastInsertRowid);
    }

    let subtotal = 0;
    const preparedItems = [];
    for (const it of items) {
      const qty = parseInt(it.qty) || 1;
      const price = parseFloat(it.price) || 0;
      subtotal += qty * price;
      let productName = 'منتج محذوف';
      let colorName = it.colorName || '';
      let colorHex = it.colorHex || '';
      let productImage = it.image || '';
      if (it.productId) {
        const pRes = await db.execute({ sql: 'SELECT name FROM products WHERE id = ?', args: [it.productId] });
        if (pRes.rows.length > 0) productName = pRes.rows[0].name;
        if (it.colorIndex !== undefined) {
          const colorsRes = await db.execute({ sql: 'SELECT * FROM product_colors WHERE product_id = ? ORDER BY sort_order, id', args: [it.productId] });
          const color = colorsRes.rows[it.colorIndex];
          if (color) {
            colorName = color.name;
            colorHex = color.hex;
            const imgRes = await db.execute({ sql: 'SELECT media_url FROM product_color_images WHERE color_id = ? ORDER BY is_main DESC, sort_order LIMIT 1', args: [color.id] });
            if (imgRes.rows.length > 0) productImage = imgRes.rows[0].media_url;
          }
        }
      }
      preparedItems.push({
        product_id: it.productId || null, product_name: productName,
        color_name: colorName, color_hex: colorHex, age_label: it.age || '',
        quantity: qty, unit_price: price, total_price: qty * price, product_image: productImage
      });
    }

    const finalDeliveryCost = parseFloat(deliveryCost) || 0;
    const total = subtotal + finalDeliveryCost;
    const orderNumber = 'ORD-' + Date.now();

    const orderRes = await db.execute({
      sql: `INSERT INTO orders
        (order_number, customer_id, first_name, last_name, phone1, phone2, wilaya, municipality, address,
         delivery_method, delivery_cost, subtotal, total, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        orderNumber, customerId, firstName, lastName, phone1, phone2 || null,
        wilaya, municipality, address, deliveryMethod || 'home', finalDeliveryCost,
        subtotal, total, notes || null
      ]
    });
    const orderId = Number(orderRes.lastInsertRowid);

    for (const pi of preparedItems) {
      await db.execute({
        sql: `INSERT INTO order_items (order_id, product_id, product_name, color_name, color_hex, age_label, quantity, unit_price, total_price, product_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [orderId, pi.product_id, pi.product_name, pi.color_name, pi.color_hex, pi.age_label, pi.quantity, pi.unit_price, pi.total_price, pi.product_image]
      });
    }

    await db.execute({ sql: `INSERT INTO order_status_history (order_id, status, note) VALUES (?, 'pending', 'تم إنشاء الطلب')`, args: [orderId] });
    await db.execute({ sql: `UPDATE customers SET total_orders = total_orders + 1, total_spent = total_spent + ? WHERE id = ?`, args: [total, customerId] });

    for (const pi of preparedItems) {
      if (pi.product_id) {
        await db.execute({ sql: 'UPDATE products SET sales_count = sales_count + ? WHERE id = ?', args: [pi.quantity, pi.product_id] });
      }
    }

    try {
      const itemsText = preparedItems.map((pi, i) =>
        `<b>${i + 1}.</b> ${escapeTelegram(pi.product_name)}\n` +
        `   🎨 ${escapeTelegram(pi.color_name || '—')} | 👶 ${escapeTelegram(pi.age_label || '—')}\n` +
        `   📦 ${pi.quantity} × ${pi.unit_price.toLocaleString()} = <b>${pi.total_price.toLocaleString()} د.ج</b>`
      ).join('\n\n');

      const deliveryLabel = { home: 'المنزل', agency: 'الوكالة' }[deliveryMethod] || 'المنزل';

      const telegramMessage =
        `🛒 <b>طلب جديد وصل!</b>\n\n` +
        `🔢 <b>رقم الطلب:</b> ${escapeTelegram(orderNumber)}\n` +
        `🕐 <b>الوقت:</b> ${new Date().toLocaleString('ar-DZ')}\n\n` +
        `👤 <b>الاسم:</b> ${escapeTelegram(firstName)} ${escapeTelegram(lastName)}\n` +
        `📞 <b>الهاتف 1:</b> ${escapeTelegram(phone1)}\n` +
        (phone2 ? `📞 <b>الهاتف 2:</b> ${escapeTelegram(phone2)}\n` : '') +
        `📍 <b>الولاية:</b> ${escapeTelegram(wilaya)}\n` +
        `🏘️ <b>البلدية:</b> ${escapeTelegram(municipality)}\n` +
        `🏠 <b>العنوان:</b> ${escapeTelegram(address)}\n\n` +
        `📦 <b>المنتجات:</b>\n${itemsText}\n\n` +
        `🚚 <b>التوصيل:</b> ${deliveryLabel} — ${finalDeliveryCost.toLocaleString()} د.ج\n` +
        `💰 <b>الإجمالي المطلوب:</b> <b>${total.toLocaleString()} د.ج</b>`;

      const ok = await sendTelegramMessage(telegramMessage);
      if (!ok) {
        console.warn('⚠️ Telegram message not sent successfully — check logs above');
      }
    } catch (tgErr) {
      console.error('❌ Telegram prep failed:', tgErr.message, tgErr.stack);
    }

    res.json({ success: true, orderId: orderNumber, id: orderId, total });
  } catch (err) { console.error('POST /orders:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    let sql = 'SELECT * FROM orders';
    const args = [];
    if (status && status !== 'all') { sql += ' WHERE status = ?'; args.push(status); }
    sql += ' ORDER BY created_at DESC';
    const result = await db.execute({ sql, args });
    const orders = [];
    for (const o of result.rows) {
      const itemsRes = await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [o.id] });
      orders.push({
        id: o.id, orderId: o.order_number, firstName: o.first_name, lastName: o.last_name,
        phone1: o.phone1, phone2: o.phone2, wilaya: o.wilaya, municipality: o.municipality, address: o.address,
        deliveryMethod: o.delivery_method, deliveryCost: o.delivery_cost, subtotal: o.subtotal,
        discount: o.discount, total: o.total, status: o.status, notes: o.notes, adminNotes: o.admin_notes,
        createdAt: o.created_at, updatedAt: o.updated_at,
        items: itemsRes.rows.map(r => ({
          productId: r.product_id, productName: r.product_name, colorName: r.color_name,
          colorHex: r.color_hex, age: r.age_label, qty: r.quantity, price: r.unit_price,
          total: r.total_price, image: r.product_image
        }))
      });
    }
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const key = req.params.id;
    const result = await db.execute({ sql: 'SELECT * FROM orders WHERE order_number = ? OR id = ?', args: [key, parseInt(key) || 0] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const o = result.rows[0];
    const itemsRes = await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [o.id] });
    const historyRes = await db.execute({ sql: 'SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at DESC', args: [o.id] });
    res.json({ ...o, orderId: o.order_number, items: itemsRes.rows, statusHistory: historyRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['pending', 'confirmed', 'out_for_delivery', 'delivered', 'cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    
    const key = req.params.id;
    const orderRes = await db.execute({ 
      sql: 'SELECT id, order_number, status FROM orders WHERE order_number = ? OR id = ?', 
      args: [key, parseInt(key) || 0] 
    });
    
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    
    const orderId = orderRes.rows[0].id;
    const orderNumber = orderRes.rows[0].order_number;
    const oldStatus = orderRes.rows[0].status;

    await db.execute({ sql: `UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`, args: [status, orderId] });
    await db.execute({ sql: `INSERT INTO order_status_history (order_id, status, changed_by_user_id, note) VALUES (?, ?, ?, ?)`, args: [orderId, status, req.user.user_id, 'تم التحديث من لوحة التحكم'] });
    
    await logAction(req.user.username, 'تغيير حالة طلب', `تم تغيير حالة الطلب ${orderNumber} من ${oldStatus} إلى ${status}`);
    
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const key = req.params.id;
    const orderRes = await db.execute({
      sql: 'SELECT * FROM orders WHERE order_number = ? OR id = ?',
      args: [key, parseInt(key) || 0]
    });
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'الطلب غير موجود' });
    const o = orderRes.rows[0];
    const itemsRes = await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [o.id] });
    const historyRes = await db.execute({ sql: 'SELECT * FROM order_status_history WHERE order_id = ?', args: [o.id] });
    const fullOrder = { ...o, items: itemsRes.rows, statusHistory: historyRes.rows };
    await saveToTrash('order', o.order_number, `${o.first_name} ${o.last_name} — ${o.total} د.ج`, fullOrder, req.user);
    await logAction(req.user.username, 'حذف طلب', `تم حذف الطلب ${o.order_number} للزبون ${o.first_name} ${o.last_name}`);
    await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [o.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 8) SETTINGS
// ============================================================
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.execute('SELECT key, value FROM settings');
    const settings = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const currentRes = await db.execute('SELECT key, value FROM settings');
    const currentSettings = {};
    for (const row of currentRes.rows) currentSettings[row.key] = row.value;
    if (Object.keys(currentSettings).length > 0) {
      await saveToTrash(
        'settings',
        Date.now().toString(),
        `إعدادات ${new Date().toLocaleString('ar-DZ')}`,
        currentSettings,
        req.user
      );
    }
    const settings = req.body || {};
    for (const [key, value] of Object.entries(settings)) {
      await db.execute({
        sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        args: [key, String(value)]
      });
    }
    await logAction(req.user.username, 'تعديل الإعدادات', 'تم تحديث إعدادات المتجر');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 9) THEME
// ============================================================
app.get('/api/theme', async (req, res) => {
  try {
    const result = await db.execute('SELECT name, color_value FROM theme_colors');
    const theme = {};
    for (const row of result.rows) theme[row.name] = row.color_value;
    res.json(theme);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/theme', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const theme = req.body || {};
    for (const [name, value] of Object.entries(theme)) {
      await db.execute({
        sql: `INSERT INTO theme_colors (name, color_value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(name) DO UPDATE SET color_value = excluded.color_value, updated_at = datetime('now')`,
        args: [name, String(value)]
      });
    }
    await logAction(req.user.username, 'تعديل الألوان', 'تم تحديث ألوان الموقع');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 10) DELIVERY
// ============================================================
app.get('/api/delivery/all', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM delivery_prices');
    const byWilaya = {};
    for (const row of result.rows) {
      if (!row.wilaya) continue;
      if (!byWilaya[row.wilaya]) byWilaya[row.wilaya] = { home: 0, agency: 0 };
      byWilaya[row.wilaya][row.delivery_type] = row.price;
    }
    res.json({ byWilaya });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/delivery/wilaya/:wilaya', async (req, res) => {
  try {
    const wilaya = decodeURIComponent(req.params.wilaya);
    const specRes = await db.execute({ sql: 'SELECT delivery_type, price FROM delivery_prices WHERE wilaya = ?', args: [wilaya] });
    const prices = { home: 0, agency: 0 };
    for (const r of specRes.rows) prices[r.delivery_type] = r.price;
    res.json(prices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/delivery/wilaya/:wilaya', authMiddleware, async (req, res) => {
  try {
    const wilaya = decodeURIComponent(req.params.wilaya);
    const { home, agency } = req.body || {};
    const upsert = async (type, price) => {
      if (price === undefined) return;
      await db.execute({
        sql: `INSERT INTO delivery_prices (delivery_type, wilaya, price, updated_at) VALUES (?, ?, ?, datetime('now')) 
              ON CONFLICT(delivery_type, wilaya) DO UPDATE SET price = excluded.price, updated_at = datetime('now')`,
        args: [type, wilaya, Number(price)]
      });
    };
    await upsert('home', home);
    await upsert('agency', agency);
    await logAction(req.user.username, 'تعديل التوصيل', `تم تحديث أسعار التوصيل لولاية ${wilaya}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 11) WILAYAS & MUNICIPALITIES
// ============================================================
app.get('/api/wilayas', async (req, res) => {
  try { const result = await db.execute('SELECT * FROM wilayas ORDER BY code'); res.json(result.rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/wilayas/:id/municipalities', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await db.execute({ sql: 'SELECT * FROM municipalities WHERE wilaya_id = ? ORDER BY name', args: [id] });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 12) UPLOAD
// ============================================================
app.post('/api/upload', authMiddleware, async (req, res) => {
  try {
    const { file, folder } = req.body;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    const result = await cloudinary.uploader.upload(file, { folder: folder || 'babyshop/uploads', resource_type: 'auto' });
    res.json({ success: true, url: result.secure_url, public_id: result.public_id, type: result.resource_type });
  } catch (err) { console.error('Upload error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
// 13) STATS
// ============================================================
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const productsCount = await db.execute('SELECT COUNT(*) as c FROM products');
    const ordersCount = await db.execute('SELECT COUNT(*) as c FROM orders');
    const pendingCount = await db.execute("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'");
    const revenue = await db.execute("SELECT COALESCE(SUM(total), 0) as s FROM orders WHERE status = 'delivered'");
    const last7 = await db.execute(`
      SELECT DATE(created_at) as day, COALESCE(SUM(total), 0) as total FROM orders
      WHERE status = 'delivered' AND created_at >= datetime('now', '-7 days')
      GROUP BY DATE(created_at)`);
    const statusCounts = await db.execute('SELECT status, COUNT(*) as c FROM orders GROUP BY status');
    const topProducts = await db.execute(`
      SELECT oi.product_name, SUM(oi.quantity) as qty, SUM(oi.total_price) as total
      FROM order_items oi INNER JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'delivered' GROUP BY oi.product_name ORDER BY qty DESC LIMIT 5`);
    res.json({
      totalProducts: Number(productsCount.rows[0].c),
      totalOrders: Number(ordersCount.rows[0].c),
      pendingOrders: Number(pendingCount.rows[0].c),
      totalRevenue: revenue.rows[0].s,
      last7Days: last7.rows,
      statusCounts: statusCounts.rows,
      topProducts: topProducts.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 14) TRASH
// ============================================================
app.get('/api/trash', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { type } = req.query;
    let sql = 'SELECT id, item_type, item_id, item_name, deleted_by_username, deleted_at FROM deleted_items';
    const args = [];
    if (type && type !== 'all') { sql += ' WHERE item_type = ?'; args.push(type); }
    sql += ' ORDER BY deleted_at DESC LIMIT 500';
    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trash/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM deleted_items WHERE id = ?',
      args: [parseInt(req.params.id)]
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
    const row = result.rows[0];
    const parsed = { ...row, item_data: JSON.parse(row.item_data) };
    if (parsed.item_type === 'user' && parsed.item_data) {
      delete parsed.item_data.password_hash;
    }
    res.json(parsed);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/trash/:id/restore', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await db.execute({ sql: 'SELECT * FROM deleted_items WHERE id = ?', args: [id] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
    const row = result.rows[0];
    const data = JSON.parse(row.item_data);

    if (row.item_type === 'product') {
      const insertRes = await db.execute({
        sql: `INSERT INTO products
          (name, slug, category, category_label, gender, price, old_price, badge, badge_type, badge_color, badge_color_name, description, stock_quantity, is_active, is_set)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          data.name, (data.slug || `restored-${Date.now()}`) + '-' + Math.floor(Math.random()*1000),
          data.category, data.categoryLabel, data.gender,
          data.price, data.oldPrice, data.badge, data.badgeType,
          data.badgeColor || '#feca57', data.badgeColorName || 'أصفر فاتح',
          data.description || '', data.stockQuantity || 0,
          data.isActive !== false ? 1 : 0,
          data.isSet ? 1 : 0
        ]
      });
      const newProductId = Number(insertRes.lastInsertRowid);
      const colorsForSave = (data.colors || []).map(c => ({
        name: c.name, hex: c.hex,
        comboName: c.comboName || null,
        partLabel: c.partLabel || null,
        images: c.images || (c.image ? [c.image] : []),
        comboAvailableAges: c.comboAvailableAges || []
      }));
      await saveProductRelations(newProductId, colorsForSave, data.ages || [], data.details || []);
      await db.execute({ sql: 'DELETE FROM deleted_items WHERE id = ?', args: [id] });
      return res.json({ success: true, newId: newProductId, message: 'تم استعادة المنتج ✓' });
    }

    if (row.item_type === 'order') {
      let orderNumber = data.order_number || `ORD-${Date.now()}`;
      const dupCheck = await db.execute({ sql: 'SELECT id FROM orders WHERE order_number = ?', args: [orderNumber] });
      if (dupCheck.rows.length > 0) orderNumber = `ORD-${Date.now()}-R`;
      const orderRes = await db.execute({
        sql: `INSERT INTO orders
          (order_number, customer_id, first_name, last_name, phone1, phone2, wilaya, municipality, address,
           delivery_method, delivery_cost, subtotal, discount, coupon_code, total, status, notes, admin_notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          orderNumber, data.customer_id || null,
          data.first_name, data.last_name, data.phone1, data.phone2,
          data.wilaya, data.municipality, data.address,
          data.delivery_method || 'home', data.delivery_cost || 0,
          data.subtotal || 0, data.discount || 0, data.coupon_code,
          data.total || 0, data.status || 'pending',
          data.notes, data.admin_notes,
          data.created_at || new Date().toISOString()
        ]
      });
      const newOrderId = Number(orderRes.lastInsertRowid);
      for (const item of (data.items || [])) {
        await db.execute({
          sql: `INSERT INTO order_items (order_id, product_id, product_name, color_name, color_hex, age_label, quantity, unit_price, total_price, product_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [newOrderId, item.product_id, item.product_name, item.color_name, item.color_hex, item.age_label, item.quantity, item.unit_price, item.total_price, item.product_image]
        });
      }
      await db.execute({ sql: 'DELETE FROM deleted_items WHERE id = ?', args: [id] });
      return res.json({ success: true, newId: newOrderId, message: 'تم استعادة الطلب ✓' });
    }

    if (row.item_type === 'user') {
      const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [data.username] });
      if (existing.rows.length > 0) return res.status(400).json({ error: 'اسم المستخدم موجود بالفعل' });
      await db.execute({
        sql: `INSERT INTO users (username, email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [data.username, data.email, data.password_hash, data.full_name, data.role, data.is_active ? 1 : 0]
      });
      await db.execute({ sql: 'DELETE FROM deleted_items WHERE id = ?', args: [id] });
      return res.json({ success: true, message: 'تم استعادة المستخدم ✓' });
    }

    if (row.item_type === 'settings') {
      for (const [key, value] of Object.entries(data)) {
        await db.execute({
          sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          args: [key, String(value)]
        });
      }
      await db.execute({ sql: 'DELETE FROM deleted_items WHERE id = ?', args: [id] });
      return res.json({ success: true, message: 'تم استعادة الإعدادات القديمة ✓' });
    }

    res.status(400).json({ error: 'نوع غير مدعوم' });
  } catch (err) {
    console.error('restore error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/trash/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM deleted_items WHERE id = ?', args: [parseInt(req.params.id)] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/trash', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await db.execute('DELETE FROM deleted_items');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 15) BACKUPS
// ============================================================
app.get('/api/backups', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, name, description, item_counts, created_by_username, is_auto, created_at FROM backups ORDER BY created_at DESC',
      args: []
    });
    const backups = result.rows.map(row => ({
      ...row,
      item_counts: row.item_counts ? JSON.parse(row.item_counts) : null
    }));
    res.json(backups);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/backups', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    const result = await createBackup(name, req.user, false);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/backups/:id/download', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM backups WHERE id = ?', args: [parseInt(req.params.id)] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
    const backup = result.rows[0];
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="babyshop-backup-${backup.id}-${new Date(backup.created_at).toISOString().slice(0,10)}.json"`);
    res.send(backup.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/backups/:id/restore', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = await db.execute({ sql: 'SELECT * FROM backups WHERE id = ?', args: [id] });
    if (result.rows.length === 0) return res.status(404).json({ error: 'غير موجود' });
    const backup = result.rows[0];
    const data = JSON.parse(backup.data);

    await createBackup(`قبل استعادة "${backup.name}"`, req.user, true);

    if (data.settings && typeof data.settings === 'object') {
      for (const [key, value] of Object.entries(data.settings)) {
        await db.execute({
          sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
          args: [key, String(value)]
        });
      }
    }
    if (data.theme && typeof data.theme === 'object') {
      for (const [name, value] of Object.entries(data.theme)) {
        await db.execute({
          sql: `INSERT INTO theme_colors (name, color_value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(name) DO UPDATE SET color_value = excluded.color_value, updated_at = datetime('now')`,
          args: [name, String(value)]
        });
      }
    }
    if (Array.isArray(data.delivery)) {
      for (const dp of data.delivery) {
        if (dp.delivery_type === 'express') continue;
        await db.execute({
          sql: `INSERT INTO delivery_prices (delivery_type, wilaya, price, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(delivery_type, wilaya) DO UPDATE SET price = excluded.price, updated_at = datetime('now')`,
          args: [dp.delivery_type, dp.wilaya, dp.price]
        });
      }
    }

    res.json({
      success: true,
      message: 'تم استعادة الإعدادات والثيم والتوصيل ✓'
    });
  } catch (err) {
    console.error('restore backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/backups/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM backups WHERE id = ?', args: [parseInt(req.params.id)] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// 16) SPA Fallback
// ============================================================
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found' });
  if (req.path.includes('.')) return res.status(404).send('File not found');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// 17) Start
// ============================================================
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    });
    setTimeout(() => { maybeAutoBackup().catch(e => console.error('auto backup:', e)); }, 30 * 1000);
    setInterval(() => { maybeAutoBackup().catch(e => console.error('auto backup:', e)); }, 60 * 60 * 1000);
  })
  .catch((err) => { console.error('❌ Failed to initialize DB:', err); process.exit(1); });