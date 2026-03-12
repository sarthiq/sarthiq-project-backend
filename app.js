require("dotenv").config();
//Checking the changes..
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { activityLogger } = require("./Middleware/activityLogger");

const { setupRoutes } = require("./Routes/setupRoutes");
const db = require("./database");
const infoRoutes = require("./infoRoutes");
const { setupModels } = require("./Models/setModels");

// Just check-checkinf git working
app = express();

app.set("trust proxy", 1); // 1 means trust the first proxy, usually Nginx or another load balancer

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
  })
);

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// Custom error handler for invalid JSON
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON format",
      error: err.message,
    });
  }
  next();
});

app.use(activityLogger);

app.use("/", infoRoutes);

setupRoutes(app);

setupModels();

db.sync()
  .then(async () => {
    app.listen(process.env.APP_PORT);
    console.log(`Listening to the port : ${process.env.APP_PORT}`);
  })
  .catch((err) => console.log(err));
