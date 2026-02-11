const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));

const upload = multer({ dest: 'uploads/' });

// ----------------------------------------------------
// 1. เชื่อมต่อฐานข้อมูล Cloud (Aiven MySQL)
// ----------------------------------------------------
// ⚠️ อย่าลืมใส่ข้อมูล Aiven ของคุณที่นี่นะครับ (Host, Password, Port)
const db = mysql.createConnection({
    host: 'raizenshop-db-raizenshop-db.e.aivencloud.com', // ใส่ Host จาก Aiven
    port: 20635,                                          // ใส่ Port จาก Aiven
    user: 'avnadmin',
    password: 'AVNS_D61Ll7j_RDGKzGYEG2N',              // 🔑 ใส่รหัสผ่าน
    database: 'defaultdb',
    ssl: { rejectUnauthorized: false }                    // ✨ จำเป็นสำหรับ Cloud
});

db.connect((err) => {
    if (err) return console.error('❌ Database Connection Failed:', err);
    console.log('✅ Connected to Aiven Database successfully!');
});

// 🛡️ Middleware: ตรวจสอบสิทธิ์แอดมิน
const isAdmin = (req, res, next) => {
    const username = req.query.admin_user || req.body.admin_user;
    if (!username) return res.status(401).json({ success: false, message: 'กรุณาระบุแอดมิน' });

    db.query("SELECT role FROM users WHERE username = ?", [username], (err, results) => {
        if (!err && results.length > 0 && results[0].role === 'admin') {
            next();
        } else {
            res.status(401).json({ success: false, message: 'เฉพาะแอดมินเท่านั้น' });
        }
    });
};

// ==========================================
// 🧑‍💻 ระบบผู้ใช้ทั่วไป (User System)
// ==========================================

// ✨ สมัครสมาชิก (แก้ให้เช็ค Email ซ้ำ)
app.post('/register', (req, res) => {
    const { 'reg-username': username, gmail: email, 'reg-password': password } = req.body;

    // 1. เช็คก่อนว่า Email นี้มีในระบบหรือยัง?
    db.query("SELECT * FROM users WHERE email = ?", [email], (err, results) => {
        if (err) return res.send("❌ Database Error: " + err);
        
        if (results.length > 0) {
            // ถ้าเจอ Email ซ้ำ ให้แจ้งเตือนและเด้งกลับ
            return res.send("<script>alert('❌ อีเมลนี้ถูกใช้งานแล้วครับ! กรุณาใช้อีเมลอื่น'); window.history.back();</script>");
        }

        // 2. ถ้าไม่ซ้ำ ค่อยบันทึกลงฐานข้อมูล
        const sql = "INSERT INTO users (username, email, password, balance, role) VALUES (?, ?, ?, 0, 'user')";
        db.query(sql, [username, email, password], (insertErr) => {
            if (insertErr) return res.send("❌ สมัครไม่ผ่าน: " + insertErr);
            res.send("<script>alert('✅ สมัครสมาชิกสำเร็จ!'); window.location.href='/Login.html';</script>");
        });
    });
});

// ✨ ล็อกอิน (ส่ง Email กลับไปเก็บไว้ใช้งานด้วย)
app.post('/login', (req, res) => {
    // ใช้ email แทน username ในการล็อกอิน (หรือจะแก้ HTML ให้ส่งเป็น email ก็ได้)
    // แต่ถ้า HTML ยังส่ง name="reg-username" เราจะรับค่ามาเช็คเทียบกับทั้ง username หรือ email
    const usernameOrEmail = req.body['reg-username']; 
    const password = req.body['reg-password'];

    // เช็คทั้ง Username และ Email ในช่องเดียว
    const sql = "SELECT * FROM users WHERE (username = ? OR email = ?) AND password = ?";
    
    db.query(sql, [usernameOrEmail, usernameOrEmail, password], (err, results) => {
        if (err) return res.send("❌ Database Error: " + err);
        
        if (results.length > 0) {
            const user = results[0];
            // ✨ บันทึกทั้ง Username และ Email ลง LocalStorage
            res.send(`<script>
                localStorage.setItem('loggedInUser', '${user.username}');
                localStorage.setItem('userEmail', '${user.email}'); 
                localStorage.setItem('userRole', '${user.role}'); 
                window.location.href='/index.html';
            </script>`);
        } else {
            res.send("<script>alert('❌ ชื่อผู้ใช้/อีเมล หรือ รหัสผ่าน ไม่ถูกต้อง!'); window.location.href='/Login.html';</script>");
        }
    });
});

// ✨ เช็คยอดเงิน (แก้ให้เช็คจาก Email ตามที่ขอ)
app.get('/api/balance', (req, res) => {
    const email = req.query.email; // รับค่า Email แทน Username
    
    if (!email) return res.json({ balance: 0 });

    db.query("SELECT balance FROM users WHERE email = ?", [email], (err, results) => {
        if (err || results.length === 0) {
            return res.json({ balance: 0 });
        }
        res.json({ balance: results[0].balance });
    });
});

// ==========================================
// 🤖 ระบบเติมเงินอัตโนมัติ (Auto Slip Verification)
// ==========================================
app.post('/topup-slip', upload.single('slipImage'), async (req, res) => {
    const { email } = req.body; // ✨ เปลี่ยนจากรับ username เป็น email
    const slipFile = req.file;
    
    if (!slipFile) return res.send("<script>alert('❌ กรุณาแนบรูปภาพสลิปครับ!'); window.history.back();</script>");
    if (!email) return res.send("<script>alert('❌ ไม่พบข้อมูลอีเมลผู้ใช้!'); window.history.back();</script>");

    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(slipFile.path));
        
        // 🚨 ใส่ API Key EasySlip ของคุณ
        const API_KEY = 'YOUR_API_KEY_HERE'; 

        const response = await axios.post('https://developer.easyslip.com/api/v1/verify', form, {
            headers: { ...form.getHeaders(), 'Authorization': `Bearer ${API_KEY}` }
        });

        const slipData = response.data.data;
        const refNumber = slipData.transRef;
        const realAmount = slipData.amount.amount;

        // เช็คสลิปซ้ำ
        db.query("SELECT * FROM used_slips WHERE ref_number = ?", [refNumber], (err, results) => {
            if (results.length > 0) {
                fs.unlinkSync(slipFile.path);
                return res.send("<script>alert('❌ สลิปนี้ถูกใช้งานไปแล้วครับ!'); window.history.back();</script>");
            }

            // ✨ เติมเงินโดยอ้างอิงจาก Email
            db.query("INSERT INTO used_slips (ref_number, username, amount) VALUES (?, ?, ?)", [refNumber, email, realAmount], () => {
                db.query("UPDATE users SET balance = balance + ? WHERE email = ?", [realAmount, email], () => {
                    fs.unlinkSync(slipFile.path);
                    res.send(`<script>alert('✅ เติมเงินสำเร็จ! ยอดเงิน ${realAmount} บาท เข้าสู่บัญชีอีเมล ${email} แล้ว'); window.location.href='/index.html';</script>`);
                });
            });
        });

    } catch (error) {
        console.error("Slip Error:", error.response ? error.response.data : error.message);
        if (slipFile && slipFile.path) fs.unlinkSync(slipFile.path);
        res.send("<script>alert('❌ ตรวจสอบสลิปไม่ผ่าน!'); window.history.back();</script>");
    }
});

// ==========================================
// 🛒 ระบบซื้อสินค้า
// ==========================================
app.get('/api/products', (req, res) => {
    const sql = "SELECT p.*, (SELECT COUNT(*) FROM product_keys pk WHERE pk.product_id = p.id AND pk.status = 'available') as stock FROM products p";
    db.query(sql, (err, results) => res.json(results || []));
});

// ✨ ซื้อสินค้า (ตัดเงินโดยเช็คจาก Email)
app.post('/api/buy-product', (req, res) => {
    const { email, productId } = req.body; // รับ email แทน username

    // เช็คยอดเงินจาก Email
    const checkSql = "SELECT u.balance, p.name, p.price, p.download_url FROM users u, products p WHERE u.email = ? AND p.id = ?";
    
    db.query(checkSql, [email, productId], (err, results) => {
        if (err || results.length === 0) return res.json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้หรือสินค้า' });
        
        const { balance, price, name, download_url } = results[0];
        if (balance < price) return res.json({ success: false, message: 'ยอดเงินของคุณไม่พอ' });

        // หาคีย์ว่าง
        db.query("SELECT id, account_data FROM product_keys WHERE product_id = ? AND status = 'available' LIMIT 1", [productId], (err, keyResults) => {
            if (err || keyResults.length === 0) return res.json({ success: false, message: 'สินค้าหมดชั่วคราว' });
            
            const { id: keyId, account_data: keyData } = keyResults[0];

            // ตัดเงินและอัปเดตสถานะคีย์
            db.query("UPDATE users SET balance = balance - ? WHERE email = ?", [price, email], () => {
                db.query("UPDATE product_keys SET status = 'sold' WHERE id = ?", [keyId], () => {
                    // บันทึกประวัติ (ใช้ email ในช่อง username ไปก่อน หรือจะแก้ตาราง order_history ให้มี col email ก็ได้)
                    db.query("INSERT INTO order_history (username, product_name, product_price, product_key, download_url) VALUES (?, ?, ?, ?, ?)", [email, name, price, keyData, download_url], () => {
                        res.json({ success: true, message: `ซื้อสำเร็จ! คีย์คือ: ${keyData}`, newBalance: balance - price });
                    });
                });
            });
        });
    });
});

// ==========================================
// ✉️ รับข้อความติดต่อ
// ==========================================
app.post('/send-message', (req, res) => {
    const { username, subject, message } = req.body;
    if (!message || message.trim() === '') return res.send("<script>alert('❌ กรุณาพิมพ์ข้อความ!'); window.history.back();</script>");
    
    db.query("INSERT INTO contact_messages (username, subject, message, status) VALUES (?, ?, ?, 'pending')", [username, subject, message], (err) => {
        if (err) return res.send("❌ Error: " + err);
        res.send(`<script>alert('✅ ส่งข้อความสำเร็จ!'); window.location.href='/Inbox.html';</script>`);
    });
});

// ดึงข้อความ User
app.get('/api/user/messages', (req, res) => {
    const { username } = req.query;
    db.query("SELECT * FROM contact_messages WHERE username = ? ORDER BY sent_at DESC", [username], (err, results) => res.json(results || []));
});

// ==========================================
// 🛠️ Admin System (คงเดิม)
// ==========================================
app.get('/api/admin/products', isAdmin, (req, res) => {
    const sql = "SELECT id, name, (SELECT COUNT(*) FROM product_keys WHERE product_id = products.id AND status = 'available') as stock FROM products";
    db.query(sql, (err, results) => res.json(results || []));
});

app.post('/api/admin/add-keys', isAdmin, (req, res) => {
    const { product_id, keys } = req.body;
    if (!product_id || !keys) return res.json({ success: false, message: 'ข้อมูลไม่ครบ' });
    const values = keys.map(k => [product_id, k, 'available']);
    db.query("INSERT INTO product_keys (product_id, account_data, status) VALUES ?", [values], (err, result) => {
        res.json({ success: true, message: `เพิ่ม ${result.affectedRows} คีย์สำเร็จ!` });
    });
});

app.post('/api/admin/add-product', isAdmin, (req, res) => {
    const { name, price, image_url, download_url } = req.body;
    db.query("INSERT INTO products (name, price, image_url, download_url) VALUES (?, ?, ?, ?)", [name, price, image_url, download_url], (err) => {
        res.json({ success: true, message: 'เพิ่มสินค้าสำเร็จ!' });
    });
});

app.delete('/api/admin/delete-product', isAdmin, (req, res) => {
    const { product_id } = req.body;
    db.query("DELETE FROM product_keys WHERE product_id = ?", [product_id], (err) => {
        db.query("DELETE FROM products WHERE id = ?", [product_id], (err) => {
            res.json({ success: true, message: 'ลบสินค้าสำเร็จ' });
        });
    });
});

app.get('/api/admin/messages', isAdmin, (req, res) => {
    db.query("SELECT * FROM contact_messages ORDER BY sent_at DESC", (err, results) => res.json(results || []));
});

app.post('/api/admin/reply-message', isAdmin, (req, res) => {
    const { message_id, reply_text } = req.body;
    db.query("UPDATE contact_messages SET admin_reply = ?, status = 'replied' WHERE id = ?", [reply_text, message_id], (err) => {
        res.json({ success: true, message: 'ตอบกลับสำเร็จ!' });
    });
});

// ใช้ Port จาก Cloud หรือ 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RaizenSHOP Server is running on port ${PORT}`));
