const crypto = require('crypto');

exports.hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

exports.maskEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return email;
  }
  
  const parts = email.split('@');
  if (parts.length !== 2) {
    return email;
  }
  
  const username = parts[0];
  const domain = parts[1];
  
  // Show first 3 characters of username, then asterisks
  const maskedUsername = username.length > 3 ? username.substring(0, 3) + '*****' : username + '*****';
  
  return maskedUsername + '@' + domain;
};

// Utility function to mask phone number
exports.maskPhoneNumber = (phone) => {
  if (!phone) return phone;
  const phoneStr = phone.toString();
  if (phoneStr.length <= 2) return phoneStr;
  
  // Keep last 2 digits and mask the rest with 'x'
  const lastTwo = phoneStr.slice(-2);
  const maskedPart = 'X'.repeat(Math.max(0, phoneStr.length - 2));
  return maskedPart + lastTwo;
};


exports.errorLog = (err) => {
  console.log(err);
};

exports.normalLog = (log) => {
  console.log(log);
};


exports.generateRandomId = (length, isCaseUpper = true) => {
  const upperLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // Uppercase letters
  const lowerLetters = "abcdefghijklmnopqrstuvwxyz"; // Lowercase letters
  const numbers = "0123456789"; // Only digits

  const letters = isCaseUpper ? upperLetters : lowerLetters;

  let letterPart = "";
  let numberPart = "";

  if (!length) {
    length = 5;
  }

  // Generate the length-letter part
  for (let i = 0; i < length; i++) {
    letterPart += letters.charAt(Math.floor(Math.random() * letters.length));
  }

  // Generate the length-digit part
  for (let i = 0; i < length; i++) {
    numberPart += numbers.charAt(Math.floor(Math.random() * numbers.length));
  }

  // Combine both parts
  return letterPart + numberPart;
};


exports.generateUniqueIdSlug = (name, id) => {
  return (
    name
      .toLowerCase()
      .replace(/['",]+/g, "")       // remove apostrophes, commas, quotes
      .replace(/[^a-z0-9]+/g, "-")  // replace non-alphanumeric with -
      .replace(/^-+|-+$/g, "")      // trim starting/ending hyphens
      + "-" + id
  );
}

/**
 * Extracts meaningful words from feed content for uniqueId generation
 * @param {string} content - The feed content string
 * @returns {string} Cleaned words extracted from content
 */
const extractWordsFromContent = (content) => {
  if (!content) return "feed";

  // Remove HTML tags and get plain text
  let plainText = content.replace(/<[^>]*>/g, " ").trim();

  // If content is too short or empty, return 'feed'
  if (plainText.length < 1) {
    return "";
  }

  // Extract first 50 characters and clean it up
  const words = plainText
    .substring(0, 50)
    .toLowerCase()
    .replace(/['",]+/g, "") // remove apostrophes, commas, quotes
    .replace(/[^a-z0-9\s]+/g, "") // remove special characters except spaces
    .replace(/\s+/g, "-") // replace spaces with hyphens
    .replace(/-+/g, "-") // remove multiple consecutive hyphens
    .replace(/^-+|-+$/g, ""); // trim starting/ending hyphens

  return words || "feed";
};

/**
 * Generates uniqueId for a single feed
 * Used during feed creation process
 * @param {number} feedId - The feed's database id
 * @param {string} feedData - The feed's content string
 * @param {string} entityName - Name of the entity (user/page/community/college/datastorage) creating the feed
 * @returns {string} The generated uniqueId
 */
exports.generateFeedUniqueIdForNewFeed = (feedId, feedData, entityName) => {
  try {
    const words = extractWordsFromContent(feedData);
    const uniqueId = `${entityName}-feed-${words}-${feedId}`;

    const finalUniqueId = uniqueId
      .toLowerCase()
      .replace(/['",]+/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");

    return finalUniqueId;
  } catch (error) {
    console.error("Error generating uniqueId for feed:", error);
    // Return a fallback uniqueId
    return `feed-${feedId}`;
  }
};

exports.extractWordsFromContent = extractWordsFromContent;