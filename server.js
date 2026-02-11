const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const multer = require('multer');
const axios = require('axios'); // ✨ เพิ่มเพื่อใช้ยิง API ตรวจสลิป
const FormData = require('form-data'); // ✨ เพิ่มเพื่อใช้ส่งไฟล์รูปสลิป
const fs = require('fs');

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json()); 
app.use(express.static(__dirname));

app.use('/uploads', express.static('uploads')); 

const upload = multer({ dest: 'uploads/' });

// // 1. เชื่อมต่อฐานข้อมูล Cloud (Aiven MySQL)
const db = mysql.createConnection({
    host: 'raizenshop-db-raizenshop-db.e.aivencloud.com', // จากช่อง Host
    port: 20635,                                          // จากช่อง Port
    user: 'avnadmin',                                     // จากช่อง User
    password: 'AVNS_D61Ll7j_RDGKzGYEG2N', // จากช่อง Password
    database: 'defaultdb',                                // จากช่อง Database name
    ssl: { rejectUnauthorized: false }                     // ✨ ต้องมีบรรทัดนี้เพื่อความปลอดภัย
});

db.connect((err) => {
    if (err) return console.error('❌ Database Connection Failed:', err);
    console.log('✅ Connected to GODSHOP Database successfully!');
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

// สมัครสมาชิก
app.post('/register', (req, res) => {
    const { 'reg-username': username, gmail: email, 'reg-password': password } = req.body;
    const sql = "INSERT INTO users (username, email, password, balance, role) VALUES (?, ?, ?, 0, 'user')";
    db.query(sql, [username, email, password], (err) => {
        if (err) return res.send("❌ เกิดข้อผิดพลาด: " + err);
        res.redirect('/index.html');
    });
});

// ล็อกอิน
app.post('/login', (req, res) => {
    const { 'reg-username': username, 'reg-password': password } = req.body;
    const sql = "SELECT * FROM users WHERE username = ? AND password = ?";
    db.query(sql, [username, password], (err, results) => {
        if (err) return res.send("❌ Database Error: " + err);
        if (results.length > 0) {
            const user = results[0];
            res.send(`<script>
                localStorage.setItem('loggedInUser', '${user.username}');
                localStorage.setItem('userRole', '${user.role}'); 
                window.location.href='/index.html';
            </script>`);
        } else {
            res.send("<script>alert('❌ Username หรือ Password ไม่ถูกต้อง!'); window.location.href='/Login.html';</script>");
        }
    });
});

// เช็คยอดเงิน
app.get('/api/balance', (req, res) => {
    const { username } = req.query;
    db.query("SELECT balance FROM users WHERE username = ?", [username], (err, results) => {
        res.json({ balance: (results && results[0]) ? results[0].balance : 0 }); 
    });
});

// ==========================================
// 🤖 ระบบเติมเงินอัตโนมัติ (Auto Slip Verification)
// ==========================================
app.post('/topup-slip', upload.single('slipImage'), async (req, res) => {
    const { username } = req.body;
    const slipFile = req.file; 
    
    if (!slipFile) return res.send("<script>alert('❌ กรุณาแนบรูปภาพสลิปครับ!'); window.history.back();</script>");

    try {
        // 1. ส่งรูปภาพสลิปไปให้ API ตรวจสอบ (EasySlip API)
        const form = new FormData();
        form.append('file', fs.createReadStream(slipFile.path));

        // 🚨 สำคัญมาก: คุณต้องไปสมัคร EasySlip.com เพื่อรับ API Key มาใส่ตรงนี้ครับ
        const API_KEY = '3629b657-e219-47fd-b40c-ead98c2c2137'; 

        const response = await axios.post('https://developer.easyslip.com/api/v1/verify', form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${API_KEY}`
            }
        });

        const slipData = response.data.data;
        
        // 2. ดึงข้อมูลจริงจากธนาคาร
        const refNumber = slipData.transRef; // รหัสอ้างอิงของธนาคาร
        const realAmount = slipData.amount.amount; // 💰 ยอดเงินจริงที่โอน (อุดช่องโหว่แก้เลข 100%)

        // 3. ตรวจสอบใน Database ว่าสลิปนี้ (Ref) เคยถูกใช้เติมไปหรือยัง?
        db.query("SELECT * FROM used_slips WHERE ref_number = ?", [refNumber], (err, results) => {
            if (results.length > 0) {
                fs.unlinkSync(slipFile.path); // ลบรูปทิ้ง
                return res.send("<script>alert('❌ สลิปนี้ถูกใช้งานไปแล้วครับ! (สลิปซ้ำ)'); window.history.back();</script>");
            }

            // 4. ถ้าสลิปถูกต้องและไม่ซ้ำ -> บันทึก Ref กันซ้ำ และ เพิ่มเงินให้ลูกค้าทันที
            db.query("INSERT INTO used_slips (ref_number, username, amount) VALUES (?, ?, ?)", [refNumber, username, realAmount], () => {
                db.query("UPDATE users SET balance = balance + ? WHERE username = ?", [realAmount, username], () => {
                    fs.unlinkSync(slipFile.path); // สำเร็จแล้ว ลบรูปทิ้งเพื่อประหยัดพื้นที่เซิร์ฟเวอร์
                    res.send(`<script>alert('✅ เติมเงินสำเร็จ! ยอดเงิน ${realAmount} บาท เข้าสู่ระบบแล้ว'); window.location.href='/index.html';</script>`);
                });
            });
        });

    } catch (error) {
        // 5. กรณีสลิปปลอม, ตัดต่อ, หรือสแกน QR ไม่ติด
        console.error("Slip Error:", error.response ? error.response.data : error.message);
        if (slipFile && slipFile.path) fs.unlinkSync(slipFile.path); // ลบรูปทิ้ง
        res.send("<script>alert('❌ ตรวจสอบสลิปไม่ผ่าน! (สลิปอาจปลอม, ดัดแปลง หรือภาพเบลอไป)'); window.history.back();</script>");
    }
});

// ✉️ รับข้อความติดต่อ
app.post('/send-message', (req, res) => {
    const { username, subject, message } = req.body;
    if (!message || message.trim() === '') {
        return res.send("<script>alert('❌ กรุณาพิมพ์ข้อความก่อนส่งครับ!'); window.history.back();</script>");
    }
    const sql = "INSERT INTO contact_messages (username, subject, message, status) VALUES (?, ?, ?, 'pending')";
    db.query(sql, [username, subject, message], (err) => {
        if (err) return res.send("❌ เกิดข้อผิดพลาดในการส่งข้อความ: " + err);
        res.send(`<script>alert('✅ ส่งข้อความสำเร็จ! ระบบจะแจ้งเตือนเมื่อแอดมินตอบกลับ'); window.location.href='/Inbox.html';</script>`);
    });
});

// ดึงสินค้าไปโชว์หน้าแรก
app.get('/api/products', (req, res) => {
    const sql = "SELECT p.*, (SELECT COUNT(*) FROM product_keys pk WHERE pk.product_id = p.id AND pk.status = 'available') as stock FROM products p";
    db.query(sql, (err, results) => res.json(results || []));
});

// ซื้อสินค้า
app.post('/api/buy-product', (req, res) => {
    const { username, productId } = req.body;
    const checkSql = "SELECT u.balance, p.name, p.price, p.download_url FROM users u, products p WHERE u.username = ? AND p.id = ?";
    db.query(checkSql, [username, productId], (err, results) => {
        if (err || results.length === 0) return res.json({ success: false, message: 'ไม่พบสินค้า' });
        const { balance, price, name, download_url } = results[0];
        if (balance < price) return res.json({ success: false, message: 'ยอดเงินของคุณไม่พอ' });

        db.query("SELECT id, account_data FROM product_keys WHERE product_id = ? AND status = 'available' LIMIT 1", [productId], (err, keyResults) => {
            if (err || keyResults.length === 0) return res.json({ success: false, message: 'สินค้าหมดชั่วคราว' });
            const { id: keyId, account_data: keyData } = keyResults[0];

            db.query("UPDATE users SET balance = balance - ? WHERE username = ?", [price, username], () => {
                db.query("UPDATE product_keys SET status = 'sold' WHERE id = ?", [keyId], () => {
                    db.query("INSERT INTO order_history (username, product_name, product_price, product_key, download_url) VALUES (?, ?, ?, ?, ?)", [username, name, price, keyData, download_url], () => {
                        res.json({ success: true, message: `ซื้อสำเร็จ! คีย์คือ: ${keyData}`, newBalance: balance - price });
                    });
                });
            });
        });
    });
});

// ดึงประวัติการซื้อ
app.get('/api/order-history', (req, res) => {
    const { username } = req.query;
    db.query("SELECT * FROM order_history WHERE username = ? ORDER BY purchase_date DESC", [username], (err, results) => {
        res.json(results || []);
    });
});

// ==========================================
// 🛠️ ระบบหลังบ้าน (Admin System)
// ==========================================

// โหลดรายชื่อสินค้า
app.get('/api/admin/products', isAdmin, (req, res) => {
    const sql = "SELECT id, name, (SELECT COUNT(*) FROM product_keys WHERE product_id = products.id AND status = 'available') as stock FROM products";
    db.query(sql, (err, results) => res.json(results || []));
});

// เพิ่มสต็อกคีย์
app.post('/api/admin/add-keys', isAdmin, (req, res) => {
    const { product_id, keys } = req.body;
    if (!product_id || !keys) return res.json({ success: false, message: 'ข้อมูลไม่ครบ' });
    const values = keys.map(k => [product_id, k, 'available']);
    db.query("INSERT INTO product_keys (product_id, account_data, status) VALUES ?", [values], (err, result) => {
        if (err) return res.json({ success: false, message: err.message });
        res.json({ success: true, message: `เพิ่มคีย์ ${result.affectedRows} รายการสำเร็จ!` });
    });
});

// เพิ่มสินค้าใหม่
app.post('/api/admin/add-product', isAdmin, (req, res) => {
    const { name, price, image_url, download_url } = req.body;
    db.query("INSERT INTO products (name, price, image_url, download_url) VALUES (?, ?, ?, ?)", [name, price, image_url, download_url], (err) => {
        if (err) return res.json({ success: false, message: err.message });
        res.json({ success: true, message: 'เพิ่มสินค้าเรียบร้อย!' });
    });
});

// ลบสินค้า
app.delete('/api/admin/delete-product', isAdmin, (req, res) => {
    const { product_id } = req.body;
    db.query("DELETE FROM product_keys WHERE product_id = ?", [product_id], (err) => {
        if (err) return res.json({ success: false, message: 'ไม่สามารถลบคีย์ที่เกี่ยวข้องได้' });
        db.query("DELETE FROM products WHERE id = ?", [product_id], (err) => {
            if (err) return res.json({ success: false, message: 'ไม่สามารถลบสินค้าได้' });
            res.json({ success: true, message: 'ลบสินค้าเรียบร้อยแล้ว' });
        });
    });
});

// ==========================================
// 📥 ระบบกล่องจดหมาย (Inbox)
// ==========================================

// 1. User ดึงข้อความของตัวเอง
app.get('/api/user/messages', (req, res) => {
    const { username } = req.query;
    const sql = "SELECT * FROM contact_messages WHERE username = ? ORDER BY sent_at DESC";
    db.query(sql, [username], (err, results) => {
        res.json(results || []);
    });
});

// 2. Admin ดึงข้อความทั้งหมด
app.get('/api/admin/messages', isAdmin, (req, res) => {
    const sql = "SELECT * FROM contact_messages ORDER BY sent_at DESC";
    db.query(sql, (err, results) => {
        res.json(results || []);
    });
});

// 3. Admin ส่งข้อความตอบกลับ
app.post('/api/admin/reply-message', isAdmin, (req, res) => {
    const { message_id, reply_text } = req.body;
    const sql = "UPDATE contact_messages SET admin_reply = ?, status = 'replied' WHERE id = ?";
    db.query(sql, [reply_text, message_id], (err) => {
        if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาดในการตอบกลับ' });
        res.json({ success: true, message: 'ส่งการตอบกลับเรียบร้อยแล้ว!' });
    });
});


app.listen(3000, () => console.log('🚀 RaizenSHOP Server is running on http://localhost:3000'));

