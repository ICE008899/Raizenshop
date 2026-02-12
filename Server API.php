<?php
// ข้อมูลจากภาพ Aiven Console
$db_host = "raizenshop-db-raizenshop-db.e.aivencloud.com";
$db_port = "20635";
$db_user = "avnadmin"; 
$db_pass = "AVNS_D61Ll7j_RDGKzGYEG2N"; // คลิกไอคอนลูกตาในหน้า Console เพื่อดูรหัส
$db_name = "defaultdb";

// เชื่อมต่อแบบใช้ SSL (Aiven บังคับ SSL Mode: REQUIRED)
$conn = mysqli_init();
mysqli_ssl_set($conn, NULL, NULL, NULL, NULL, NULL);
if (!mysqli_real_connect($conn, $db_host, $db_user, $db_pass, $db_name, $db_port)) {
    die("Connection failed");
}

$key  = $_GET['key'];
$hwid = $_GET['hwid'];

// ค้นหาในตาราง product_keys ตามที่คุณตั้งไว้ใน HeidiSQL
$stmt = $conn->prepare("SELECT status FROM product_keys WHERE account_data = ? LIMIT 1");
$stmt->bind_param("s", $key);
$stmt->execute();
$result = $stmt->get_result();

if ($result->num_rows > 0) {
    $row = $result->fetch_assoc();
    $db_status = $row['status'];

    if ($db_status == "available" || empty($db_status)) {
        // อัปเดต HWID ลงในคอลัมน์ status
        $update = $conn->prepare("UPDATE product_keys SET status = ? WHERE account_data = ?");
        $update->bind_param("ss", $hwid, $key);
        $update->execute();
        echo "SUCCESS";
    } else if ($db_status == $hwid) {
        echo "SUCCESS";
    } else {
        echo "HWID_MISMATCH";
    }
} else {
    echo "INVALID_KEY";
}
$conn->close();
?>