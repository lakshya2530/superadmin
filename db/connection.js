const mysql = require("mysql2");

const pool = mysql.createPool({
  host: "localhost",
  user: "root", // your MySQL username
  password: "", // your MySQL password
  database: "superadmin", // database name
  connectionLimit: 10,
});

pool.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
  } else {
    console.log("✅ Connected to MySQL Database: oneroute");
    connection.release();
  }
});

module.exports = pool.promise(); // use promise wrapper
