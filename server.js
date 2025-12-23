// const express = require("express");
// const dotenv = require("dotenv");
// const path = require("path");

// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 3000;

// // Middleware
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));
// // ✅ Serve uploads folder publicly
// app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// // Test route
// app.get("/", (req, res) => {
//   res.send("🚀 API is working fine!");
// });

// // Routes
// const userRoutes = require("./routes/users");
// const vehicleRoutes = require("./routes/vehicles");
// const accountRoutes = require("./routes/account");
// const ridesRoutes = require("./routes/rides");
// const cahtRoutes = require("./routes/chat");

// // admin
// const adminCmsRoutes = require("./admin/routes/cms");
// const adminTicketRoutes = require("./admin/routes/ticket");
// const commissionRoutes = require("./admin/routes/commission");
// const bookingsRoutes = require("./admin/routes/bookings");


// app.use("/api/users", userRoutes);
// app.use("/api/vehicles", vehicleRoutes);
// app.use("/api/accounts", accountRoutes);
// app.use("/api/rides", ridesRoutes);
// app.use("/api/chat", cahtRoutes);

// app.use("/api/admin/cms", adminCmsRoutes);
// app.use("/api/admin/ticket", adminTicketRoutes);
// app.use("/api/admin/commission", commissionRoutes);
// app.use("/api/admin/bookings", bookingsRoutes);


// // Start server
// app.listen(PORT, () => {
//   console.log(
//     `Server running on ${process.env.BASE_URL || "http://localhost:" + PORT}`
//   );
// });


// const express = require("express");
// const dotenv = require("dotenv");
// const path = require("path");
// const fs = require("fs");
// const http = require("http");
// const https = require("https");

// dotenv.config();

// const app = express();
// const HTTP_PORT = process.env.PORT || 3000;
// const HTTPS_PORT = process.env.HTTPS_PORT || 3001;

// // Middleware
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));

// // Serve uploads
// app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// // Test route
// app.get("/", (req, res) => {
//   res.send("🚀 API is working on HTTP & HTTPS!");
// });

// // Routes
// const userRoutes = require("./routes/users");
// const vehicleRoutes = require("./routes/vehicles");
// const accountRoutes = require("./routes/account");
// const ridesRoutes = require("./routes/rides");
// const chatRoutes = require("./routes/chat");

// // Admin routes
// const adminCmsRoutes = require("./admin/routes/cms");
// const adminTicketRoutes = require("./admin/routes/ticket");
// const commissionRoutes = require("./admin/routes/commission");
// const bookingsRoutes = require("./admin/routes/bookings");

// app.use("/api/users", userRoutes);
// app.use("/api/vehicles", vehicleRoutes);
// app.use("/api/accounts", accountRoutes);
// app.use("/api/rides", ridesRoutes);
// app.use("/api/chat", chatRoutes);

// app.use("/api/admin/cms", adminCmsRoutes);
// app.use("/api/admin/ticket", adminTicketRoutes);
// app.use("/api/admin/commission", commissionRoutes);
// app.use("/api/admin/bookings", bookingsRoutes);

// // 🔐 SSL Certificate (UPDATE PATHS!)
// const privateKey = fs.readFileSync(path.join(__dirname, "ssl/key.pem"));
// const certificate = fs.readFileSync(path.join(__dirname, "ssl/cert.pem"));

// const credentials = { key: privateKey, cert: certificate };

// // 🌍 Create HTTP & HTTPS servers
// const httpServer = http.createServer(app);
// const httpsServer = https.createServer(credentials, app);

// // 🚀 Start Servers
// httpServer.listen(HTTP_PORT, () => {
//   console.log(`HTTP Server Running → http://localhost:${HTTP_PORT}`);
// });

// httpsServer.listen(HTTPS_PORT, () => {
//   console.log(`HTTPS Server Running → https://localhost:${HTTPS_PORT}`);
// });



const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const cors = require("cors");

dotenv.config();

const app = express();
const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3001;

// Enable CORS
app.use(cors({
  origin: ["http://localhost:5173","http://localhost:3010", "https://72.61.232.245"],
  credentials: true
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Test route
app.get("/", (req, res) => {
  res.send("🚀 API is working on HTTP & HTTPS!");
});

// Routes
const userRoutes = require("./routes/users");
const vehicleRoutes = require("./routes/vehicles");
const accountRoutes = require("./routes/account");
const ridesRoutes = require("./routes/rides");
const chatRoutes = require("./routes/chat");

// Admin routes
const adminCmsRoutes = require("./admin/routes/cms");
const adminTicketRoutes = require("./admin/routes/ticket");
const commissionRoutes = require("./admin/routes/commission");
const bookingsRoutes = require("./admin/routes/bookings");
const vehicleAdminRoutes = require("./admin/routes/vehicle");
const usersAdminRoutes = require("./admin/routes/users");
const ridesAdminRoutes = require("./admin/routes/rides");
const dashboardAdminRoutes = require("./admin/routes/dashboard");
// superadmin
const settingRoutes = require("./admin/routes/settings");
const auditLogsRouter = require('./admin/routes/auditLogs');
const notificationsRouter = require('./admin/routes/notifications');


app.use("/api/users", userRoutes);
app.use("/api/vehicles", vehicleRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/rides", ridesRoutes);
app.use("/api/chat", chatRoutes);

app.use("/api/admin/cms", adminCmsRoutes);
app.use("/api/admin/ticket", adminTicketRoutes);
app.use("/api/admin/commission", commissionRoutes);
app.use("/api/admin/bookings", bookingsRoutes);
app.use("/api/admin/admin-vehicle", vehicleAdminRoutes);
app.use("/api/admin/admin-users", usersAdminRoutes);
app.use("/api/admin/admin-rides", ridesAdminRoutes);
app.use("/api/admin/dashboard", dashboardAdminRoutes);

// super admin
app.use("/api/admin/settings", settingRoutes);
app.use("/api/admin/audit-log", auditLogsRouter);
app.use("/api/admin/notifications", notificationsRouter);

// SSL Certificate
const privateKey = fs.readFileSync(path.join(__dirname, "ssl/key.pem"));
const certificate = fs.readFileSync(path.join(__dirname, "ssl/cert.pem"));

const credentials = { key: privateKey, cert: certificate };

// Create HTTP & HTTPS servers
const httpServer = http.createServer(app);
const httpsServer = https.createServer(credentials, app);

// Start Servers
httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP Server Running → http://localhost:${HTTP_PORT}`);
});

httpsServer.listen(HTTPS_PORT, () => {
  console.log(`HTTPS Server Running → https://localhost:${HTTPS_PORT}`);
});
