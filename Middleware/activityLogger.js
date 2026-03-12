const useragent = require("express-useragent");
const { detectClientIP, getGeolocation } = require("../Utils/ipUtils");

const activityLogger = (req, res, next) => {
  // Detect client IP information
  const { ipAddresses, primaryIpAddress } = detectClientIP(req);

  // Extracting User-Agent
  const userAgent = req.headers["user-agent"] || "Unknown";

  // Device Type (Desktop/Mobile/Tablet)
  const ua = useragent.parse(userAgent);
  const deviceType = ua.isMobile ? "Mobile" : "Desktop";

  // Get geolocation information
  const { location, geo } = getGeolocation(ipAddresses, primaryIpAddress);

  // Store client information in request object
  req.clientInfo = {
    ipAddresses,
    primaryIpAddress,
    userAgent,
    deviceType,
    location,
    geoData: geo || null
  };

  // Continue with next middleware or response
  next();
};

module.exports = {
  activityLogger
};
