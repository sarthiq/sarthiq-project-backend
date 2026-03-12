const geoip = require("geoip-lite");
const https = require("https");

// Helper function to check if IP is localhost/private
function isLocalhost(ip) {
  if (!ip) return true;
  
  const localhostPatterns = [
    '::1',
    '127.0.0.1',
    '::ffff:127.0.0.1',
    'localhost'
  ];
  
  const privatePatterns = [
    /^192\.168\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./
  ];
  
  return localhostPatterns.includes(ip) || 
         privatePatterns.some(pattern => pattern.test(ip));
}

// Fallback geolocation function using external API
function getGeolocationFallback(ip) {
  return new Promise((resolve) => {
    if (isLocalhost(ip)) {
      resolve(null);
      return;
    }

    const options = {
      hostname: 'ip-api.com',
      port: 443,
      path: `/json/${ip}?fields=status,message,country,regionName,city,timezone,query`,
      method: 'GET',
      timeout: 3000
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const geoData = JSON.parse(data);
          if (geoData.status === 'success' && geoData.country) {
            resolve({
              city: geoData.city,
              country: geoData.country,
              region: geoData.regionName,
              timezone: geoData.timezone
            });
          } else {
            resolve(null);
          }
        } catch (error) {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

// Enhanced IP detection function
function detectClientIP(req) {
  let ipAddresses = [];
  let primaryIpAddress = null;

  // Check various proxy headers in order of preference
  const ipHeaders = [
    'x-forwarded-for',
    'x-real-ip',
    'x-client-ip',
    'cf-connecting-ip', // Cloudflare
    'x-cluster-client-ip',
    'x-forwarded',
    'forwarded-for',
    'forwarded'
  ];

  // Try to get IP from proxy headers first
  for (const header of ipHeaders) {
    const headerValue = req.headers[header];
    if (headerValue) {
      // Handle comma-separated IPs (x-forwarded-for can have multiple IPs)
      const ips = headerValue.split(',').map(ip => ip.trim());
      ipAddresses = [...ipAddresses, ...ips];
      
      // Use the first non-localhost IP as primary
      if (!primaryIpAddress) {
        const nonLocalIp = ips.find(ip => 
          ip && 
          ip !== '::1' && 
          ip !== '127.0.0.1' && 
          ip !== '::ffff:127.0.0.1' &&
          !ip.startsWith('192.168.') &&
          !ip.startsWith('10.') &&
          !ip.startsWith('172.')
        );
        if (nonLocalIp) {
          primaryIpAddress = nonLocalIp;
        }
      }
    }
  }

  // Fallback to connection remote address if no external IP found
  if (!primaryIpAddress) {
    const remoteAddress = req.connection.remoteAddress || req.socket.remoteAddress;
    if (remoteAddress) {
      ipAddresses.push(remoteAddress);
      primaryIpAddress = remoteAddress;
    }
  }

  // If still no IP, use localhost as fallback
  if (!primaryIpAddress) {
    primaryIpAddress = '127.0.0.1';
    ipAddresses = ['127.0.0.1'];
  }

  // Remove duplicates
  ipAddresses = [...new Set(ipAddresses)];

  return {
    ipAddresses,
    primaryIpAddress
  };
}

// Enhanced geolocation function
function getGeolocation(ipAddresses, primaryIpAddress) {
  let location = "Unknown";
  let geo = null;

  // Try geolocation with the primary IP
  if (primaryIpAddress && !isLocalhost(primaryIpAddress)) {
    geo = geoip.lookup(primaryIpAddress);
    if (geo) {
      // Show country only if city is not available
      if (geo.city) {
        location = `${geo.city}, ${geo.country}`;
      } else if (geo.country) {
        location = geo.country;
      }
    }
  }

  // If geolocation failed and we have other IPs, try them
  if (location === "Unknown" && ipAddresses.length > 1) {
    for (const ip of ipAddresses) {
      if (!isLocalhost(ip)) {
        geo = geoip.lookup(ip);
        if (geo) {
          // Show country only if city is not available
          if (geo.city) {
            location = `${geo.city}, ${geo.country}`;
          } else if (geo.country) {
            location = geo.country;
          }
          break;
        }
      }
    }
  }

  // If still no location found and we have a non-localhost IP, try fallback service
  if (location === "Unknown" && primaryIpAddress && !isLocalhost(primaryIpAddress)) {
    // Note: This is async, but we'll handle it in a non-blocking way
    getGeolocationFallback(primaryIpAddress).then(fallbackGeo => {
      if (fallbackGeo) {
        console.log(`Fallback geolocation found for ${primaryIpAddress}:`, fallbackGeo);
      }
    }).catch(() => {
      // Silently handle fallback failures
    });
  }

  return {
    location,
    geo
  };
}

module.exports = {
  isLocalhost,
  getGeolocationFallback,
  detectClientIP,
  getGeolocation
};
