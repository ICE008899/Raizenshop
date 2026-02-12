<?php
/**
 * RaizenSHOP Authentication API
 * เชื่อมต่อ Aiven MySQL และรองรับการทำงานกับ Batch Script
 */

// 1. ตั้งค่าการส่งข้อมูลกลับเป็น Text ธรรมดา และปิด Error ทุกอย่างไม่ให้ปนออกไป
header('Content-Type: text/plain; charset=utf-8');
error_reporting(0);
ini_set('display_errors', 0);

// 2. ข้อมูลเชื่อมต่อจาก Aiven Console (อ้างอิงรหัสผ่านที่คุณใช้ล่าสุด)
$db_host = "raizenshop-db-raizenshop-db.e.aivencloud.com";
$db_port = "20635";
$db_user = "avnadmin"; 
$db_pass = "AVNS_D61Ll7j_RDGKzGYEG2N"; 
$db_name = "defaultdb";

// 3. เริ่มการเชื่อมต่อแบบ SSL (จำเป็นสำหรับ Aiven Cloud)
$conn = mysqli_init();
mysqli_ssl_set($conn, NULL, NULL, NULL, NULL, NULL);

// ป้องกันการค้างกรณี DB ติดต่อไม่ได้
if (!mysqli_real_connect($conn, $db_host, $db_user, $db_pass, $db_name, $db_port, NULL, MYSQLI_CLIENT_SSL)) {
    ob_clean();
    die("CONNECTION_FAILED");
}

// 4. รับค่าและทำความสะอาดข้อมูล (ลบช่องว่าง)
$key  = isset($_GET['key']) ? trim($_GET['key']) : '';
$hwid = isset($_GET['hwid']) ? trim($_GET['hwid']) : '';

if (empty($key) || empty($hwid)) {
    ob_clean();
    die("EMPTY_INPUT");
}

// 5. ตรวจสอบคีย์ในตาราง product_keys
$sql = "SELECT status FROM product_keys WHERE account_data = ? LIMIT 1";
$stmt = $conn->prepare($sql);
$stmt->bind_param("s", $key);
$stmt->execute();
$result = $stmt->get_result();

// เคลียร์ Buffer เพื่อให้แน่ใจว่าไม่มี HTML หลุดออกไป
ob_clean();

if ($result->num_rows > 0) {
    $row = $result->fetch_assoc();
    $db_status = trim($row['status']);

    // กรณีคีย์ยังว่าง (available) -> ลงทะเบียน HWID
    if ($db_status == "available" || empty($db_status)) {
        $update = $conn->prepare("UPDATE product_keys SET status = ? WHERE account_data = ?");
        $update->bind_param("ss", $hwid, $key);
        if ($update->execute()) {
            echo "SUCCESS";
        } else {
            echo "UPDATE_FAILED";
        }
    } 
    // กรณี HWID ตรงกับที่เคยลงทะเบียนไว้
    else if ($db_status == $hwid) {
        echo "SUCCESS";
    } 
    // กรณีคีย์ถูกใช้ไปแล้วกับเครื่องอื่น
    else {
        echo "HWID_MISMATCH";
    }
} else {
    echo "INVALID_KEY";
}

$conn->close();
exit(); // จบการทำงานทันทีเพื่อป้องกันอักขระส่วนเกิน
?>
