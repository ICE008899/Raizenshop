<?php
// ปิดการแสดงผล Error เพื่อป้องกันการส่งข้อความอื่นไปกวนสคริปต์ Batch
error_reporting(0);

// ข้อมูลเชื่อมต่อจาก Aiven Console ของคุณ
$db_host = "raizenshop-db-raizenshop-db.e.aivencloud.com";
$db_port = "20635";
$db_user = "avnadmin"; 
$db_pass = "AVNS_D61Ll7j_RDGKzGYEG2N"; 
$db_name = "defaultdb";

// เริ่มการเชื่อมต่อแบบ SSL (Aiven บังคับ SSL Mode: REQUIRED)
$conn = mysqli_init();
mysqli_ssl_set($conn, NULL, NULL, NULL, NULL, NULL);

if (!mysqli_real_connect($conn, $db_host, $db_user, $db_pass, $db_name, $db_port)) {
    die("CONNECTION_FAILED");
}

// รับค่าจาก URL และลบช่องว่างส่วนเกิน
$key  = isset($_GET['key']) ? trim($_GET['key']) : '';
$hwid = isset($_GET['hwid']) ? trim($_GET['hwid']) : '';

if (empty($key) || empty($hwid)) {
    die("EMPTY_INPUT");
}

// ตรวจสอบคีย์ในตาราง product_keys ที่ตั้งไว้ใน HeidiSQL
$sql = "SELECT status FROM product_keys WHERE account_data = ? LIMIT 1";
$stmt = $conn->prepare($sql);
$stmt->bind_param("s", $key);
$stmt->execute();
$result = $stmt->get_result();

if ($result->num_rows > 0) {
    $row = $result->fetch_assoc();
    $db_status = trim($row['status']);

    // ถ้าสถานะว่าง (available) ให้ผูก HWID ทันที
    if ($db_status == "available" || empty($db_status)) {
        $update = $conn->prepare("UPDATE product_keys SET status = ? WHERE account_data = ?");
        $update->bind_param("ss", $hwid, $key);
        $update->execute();
        echo "SUCCESS";
    } 
    // ถ้าผูกไว้แล้ว ต้องตรงกับเครื่องที่ส่งมา
    else if ($db_status == $hwid) {
        echo "SUCCESS";
    } 
    // กรณี HWID ไม่ตรง (มีการย้ายเครื่อง)
    else {
        echo "HWID_MISMATCH";
    }
} else {
    echo "INVALID_KEY";
}

$conn->close();
?>
