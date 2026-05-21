const express = require("express");
const cors = require("cors");
require("dotenv").config();
const loginRoutes = require("./routes/loginRoutes");
const userRoutes = require("./routes/User");

// New Routes
const gradationRoutes = require("./routes/gradationRoutes");
const productRoutes = require("./routes/productRoutes");
const purchaseRoutes = require("./routes/purchaseRoutes");
const salesRoutes = require("./routes/salesRoutes");
const vehicleRoutes = require("./routes/vehicleRoutes");
const partyRoutes = require("./routes/partyRoutes");
const todoRoutes = require("./routes/todos");

const app = express();
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Server running...");
});


app.use("/api", loginRoutes);
app.use("/api/user", userRoutes);
app.use("/api/gradation", gradationRoutes);
app.use("/api/product", productRoutes);
app.use("/api/purchase", purchaseRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/vehicle", vehicleRoutes);
app.use("/api/party", partyRoutes);
app.use("/api/todos", todoRoutes);


app.listen(process.env.PORT || 5000, () => {
  console.log(`Server running on port ${process.env.PORT || 5000}`);
});