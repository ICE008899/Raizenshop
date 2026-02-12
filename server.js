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
const db = mysql.createConnection({
    host: 'raizenshop-db-raizenshop-db.e.aivencloud.com',
    port: 20635,
    user: 'avnadmin',
    // ⚠️ อย่าลืมใส่รหัสผ่าน Aiven ของคุณที่นี่
    password: 'AVNS_D61Ll7j_RDGKzGYEG2N', 
    database: 'defaultdb',
    ssl: { rejectUnauthorized: false }
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
// 🧑‍💻 ระบบผู้ใช้ทั่วไป (สมัคร/ล็อกอิน/เช็คยอด)
// ==========================================

// สมัครสมาชิก
app.post('/register', (req, res) => {
    const username = req.body['reg-username'];
    const email = req.body.gmail || req.body.email; 
    const password = req.body['reg-password'];

    db.query("SELECT * FROM users WHERE email = ?", [email], (err, results) => {
        if (err) return res.send("❌ Database Error: " + err);
        if (results.length > 0) {
            return res.send("<script>alert('❌ อีเมลนี้ถูกใช้งานแล้วครับ!'); window.history.back();</script>");
        }
        const sql = "INSERT INTO users (username, email, password, balance, role) VALUES (?, ?, ?, 0, 'user')";
        db.query(sql, [username, email, password], (insertErr) => {
            if (insertErr) return res.send("❌ สมัครไม่ผ่าน: " + insertErr);
            res.send("<script>alert('✅ สมัครสมาชิกสำเร็จ!'); window.location.href='/Login.html';</script>");
        });
    });
});

// ล็อกอิน
app.post('/login', (req, res) => {
    const usernameOrEmail = req.body['reg-username']; 
    const password = req.body['reg-password'];

    const sql = "SELECT * FROM users WHERE (username = ? OR email = ?) AND password = ?";
    db.query(sql, [usernameOrEmail, usernameOrEmail, password], (err, results) => {
        if (err) return res.send("❌ Database Error: " + err);
        if (results.length > 0) {
            const user = results[0];
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

// เช็คยอดเงิน
app.get('/api/balance', (req, res) => {
    const email = req.query.email;
    if (!email) return res.json({ balance: 0 });
    db.query("SELECT balance FROM users WHERE email = ?", [email], (err, results) => {
        if (err || results.length === 0) return res.json({ balance: 0 });
        res.json({ balance: results[0].balance });
    });
});

// 📜 ดึงประวัติการซื้อ (สำหรับ History.html)
app.get('/api/order-history', (req, res) => {
    const email = req.query.email;
    db.query("SELECT * FROM order_history WHERE username = ? ORDER BY purchase_date DESC", [email], (err, results) => {
        if (err) {
            console.error("History Error:", err);
            return res.json([]);
        }
        res.json(results || []);
    });
});

// ==========================================
// 🤖 ระบบเติมเงินอัตโนมัติ (EasySlip)
// ==========================================
app.post('/topup-slip', upload.single('slipImage'), async (req, res) => {
    const { email } = req.body;
    const slipFile = req.file;
    
    console.log("------------------------------------------------");
    console.log("🔍 เริ่มกระบวนการเติมเงิน...");
    console.log("📧 อีเมลเป้าหมาย:", email);

    if (!slipFile) return res.send("<script>alert('❌ กรุณาแนบรูปภาพสลิปครับ!'); window.history.back();</script>");
    if (!email || email === 'null' || email === 'undefined') {
        console.log("❌ Error: ไม่ได้รับค่าอีเมล");
        return res.send("<script>alert('❌ ไม่พบข้อมูลผู้ใช้! กรุณา Logout แล้ว Login ใหม่ 1 ครั้งครับ'); window.location.href='/Login.html';</script>");
    }

    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(slipFile.path));
        
        // 🔑 EasySlip API Key
        const API_KEY = '3629b657-e219-47fd-b40c-ead98c2c2137'; 

        const response = await axios.post('https://developer.easyslip.com/api/v1/verify', form, {
            headers: { ...form.getHeaders(), 'Authorization': `Bearer ${API_KEY}` }
        });

        if (response.data.status !== 200) {
            throw new Error(response.data.message || "EasySlip API Error");
        }

        const slipData = response.data.data;
        const refNumber = slipData.transRef;
        const realAmount = slipData.amount.amount;

        console.log(`✅ สลิปผ่าน! ยอดเงิน: ${realAmount} บาท`);

        db.query("SELECT * FROM used_slips WHERE ref_number = ?", [refNumber], (err, results) => {
            if (results.length > 0) {
                fs.unlinkSync(slipFile.path);
                return res.send("<script>alert('❌ สลิปนี้ถูกใช้งานไปแล้วครับ!'); window.history.back();</script>");
            }

            db.query("INSERT INTO used_slips (ref_number, username, amount) VALUES (?, ?, ?)", [refNumber, email, realAmount], (insertErr) => {
                db.query("UPDATE users SET balance = balance + ? WHERE email = ?", [realAmount, email], (updateErr, updateResult) => {
                    fs.unlinkSync(slipFile.path);

                    if (updateResult.affectedRows === 0) {
                        console.log("😱 Critical Error: หาอีเมลไม่เจอในฐานข้อมูล!");
                        return res.send(`<script>alert('❌ เติมเงินไม่เข้า! ระบบหาอีเมล ${email} ไม่เจอ'); window.history.back();</script>`);
                    }

                    console.log("🎉 เติมเงินสำเร็จ!");
                    res.send(`<script>alert('✅ เติมเงินสำเร็จ! ยอดเงิน ${realAmount} บาท เข้าสู่บัญชีเรียบร้อย'); window.location.href='/index.html';</script>`);
                });
            });
        });

    } catch (error) {
        console.error("❌ Slip Error:", error.message);
        if (slipFile && slipFile.path) fs.unlinkSync(slipFile.path);
        const errorMsg = error.response && error.response.data ? error.response.data.message : error.message;
        res.send(`<script>alert('❌ ตรวจสอบสลิปไม่ผ่าน: ${errorMsg}'); window.history.back();</script>`);
    }
});

// ==========================================
// 🛒 ระบบซื้อสินค้า
// ==========================================
app.get('/api/products', (req, res) => {
    // ดึงสินค้าพร้อมเช็คสต็อก
    const sql = "SELECT p.*, (SELECT COUNT(*) FROM product_keys pk WHERE pk.product_id = p.id AND pk.status = 'available') as stock FROM products p";
    db.query(sql, (err, results) => res.json(results || []));
});

app.post('/api/buy-product', (req, res) => {
    const { email, productId } = req.body;
    
    // เช็คเงินและข้อมูลสินค้า
    const checkSql = "SELECT u.balance, p.name, p.price, p.download_url FROM users u, products p WHERE u.email = ? AND p.id = ?";
    db.query(checkSql, [email, productId], (err, results) => {
        if (err || results.length === 0) return res.json({ success: false, message: 'ไม่พบข้อมูลผู้ใช้หรือสินค้า' });
        
        const { balance, price, name, download_url } = results[0];
        if (balance < price) return res.json({ success: false, message: 'ยอดเงินของคุณไม่พอ' });

        // หาคีย์ว่าง 1 อัน
        db.query("SELECT id, account_data FROM product_keys WHERE product_id = ? AND status = 'available' LIMIT 1", [productId], (err, keyResults) => {
            if (err || keyResults.length === 0) return res.json({ success: false, message: 'สินค้าหมดชั่วคราว' });
            
            const { id: keyId, account_data: keyData } = keyResults[0];

            // ตัดเงิน -> เปลี่ยนสถานะคีย์ -> บันทึกประวัติ
            db.query("UPDATE users SET balance = balance - ? WHERE email = ?", [price, email], () => {
                db.query("UPDATE product_keys SET status = 'sold' WHERE id = ?", [keyId], () => {
                    db.query("INSERT INTO order_history (username, product_name, product_price, product_key, download_url) VALUES (?, ?, ?, ?, ?)", [email, name, price, keyData, download_url], () => {
                        res.json({ success: true, message: `ซื้อสำเร็จ! คีย์คือ: ${keyData}`, newBalance: balance - price });
                    });
                });
            });
        });
    });
});

// ==========================================
// ✉️ ระบบข้อความ & Admin
// ==========================================
app.post('/send-message', (req, res) => {
    const { username, subject, message } = req.body;
    db.query("INSERT INTO contact_messages (username, subject, message, status) VALUES (?, ?, ?, 'pending')", [username, subject, message], (err) => {
        res.send(`<script>alert('✅ ส่งข้อความสำเร็จ!'); window.location.href='/Inbox.html';</script>`);
    });
});

app.get('/api/user/messages', (req, res) => {
    const { username } = req.query;
    db.query("SELECT * FROM contact_messages WHERE username = ? ORDER BY sent_at DESC", [username], (err, results) => res.json(results || []));
});

// --- Admin Endpoints ---
app.get('/api/admin/products', isAdmin, (req, res) => {
    const sql = "SELECT id, name, (SELECT COUNT(*) FROM product_keys WHERE product_id = products.id AND status = 'available') as stock FROM products";
    db.query(sql, (err, results) => res.json(results || []));
});

app.post('/api/admin/add-keys', isAdmin, (req, res) => {
    const { product_id, keys } = req.body;
    const values = keys.map(k => [product_id, k, 'available']);
    db.query("INSERT INTO product_keys (product_id, account_data, status) VALUES ?", [values], (err, result) => {
        res.json({ success: true, message: `เพิ่มสำเร็จ!` });
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
// ==========================================
// 🔐 API สำหรับเช็ค Key (ฉบับสมบูรณ์ & มี Log)
// ==========================================
app.get('/api/auth', (req, res) => {
    // 1. ตั้งค่า Header เป็น Text ธรรมดา (สำคัญมากสำหรับ Batch)
    res.set('Content-Type', 'text/plain');

    // 2. รับค่าและตัดช่องว่างหัว-ท้ายออก (Trim) ป้องกัน Error โง่ๆ
    const key = req.query.key ? req.query.key.trim() : '';
    const hwid = req.query.hwid ? req.query.hwid.trim() : '';

    // Log ให้แอดมินดูใน Render ว่าใครส่งอะไรมา
    console.log(`[AUTH CHECK] Key: ${key} | HWID: ${hwid}`);

    if (!key || !hwid) {
        return res.send("EMPTY_INPUT");
    }

    // 3. ค้นหาคีย์ใน Database
    db.query("SELECT * FROM product_keys WHERE account_data = ? LIMIT 1", [key], (err, results) => {
        if (err) {
            console.error("[DB ERROR]", err);
            return res.send("DB_ERROR");
        }

        // กรณี 1: ไม่พบคีย์ในระบบเลย (ต้องตอบ INVALID_KEY)
        if (results.length === 0) {
            console.log(`❌ [AUTH FAIL] Key not found: ${key}`);
            return res.send("INVALID_KEY");
        }

        // ดึงสถานะคีย์ออกมา
        const row = results[0];
        const dbStatus = row.status ? row.status.trim() : ''; 

        // กรณี 2: คีย์ว่าง (available) -> ให้ผูก HWID ทันที
        if (dbStatus === 'available' || dbStatus === '') {
            db.query("UPDATE product_keys SET status = ? WHERE account_data = ?", [hwid, key], (updateErr) => {
                if (updateErr) {
                    console.error("[UPDATE ERROR]", updateErr);
                    return res.send("UPDATE_FAILED");
                }
                console.log(`✅ [AUTH SUCCESS] New Device Bound: ${hwid}`);
                return res.send("SUCCESS");
            });
        } 
        // กรณี 3: คีย์เคยใช้แล้ว และ HWID ตรงกัน (ผ่าน)
        else if (dbStatus === hwid) {
            console.log(`✅ [AUTH SUCCESS] HWID Matched.`);
            return res.send("SUCCESS");
        } 
        // กรณี 4: คีย์เคยใช้แล้ว แต่ HWID ไม่ตรง (ไม่ผ่าน)
        else {
            console.log(`⛔ [AUTH DENIED] HWID Mismatch! DB: ${dbStatus} vs Client: ${hwid}`);
            return res.send("HWID_MISMATCH");
        }
    });
});
// ✅ รัน Server (รองรับ Render Port)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RaizenSHOP Server is running on port ${PORT}`));


