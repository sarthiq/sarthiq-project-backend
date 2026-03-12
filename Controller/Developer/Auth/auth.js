const { DEVELOPER_PASSWORD, DEVELOPER_USERNAME, JWT_SECRET_KEY, DeveloperTokenExpiresIn } = require("../../../importantInfo")
const jwt = require('jsonwebtoken')


exports.developerLogin = async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validate developer credentials
        if (username !== DEVELOPER_USERNAME || password !== DEVELOPER_PASSWORD) {
            return res.status(402).json({
                success: false,
                message: "Invalid developer credentials"
            });
        }
        

        // Create JWT token
        const token = jwt.sign(
            { username: DEVELOPER_USERNAME },
            JWT_SECRET_KEY,
            { expiresIn: DeveloperTokenExpiresIn }
        );

        return res.status(200).json({
            success: true,
            message: "Developer login successful",
            token: token
        });

    } catch (error) {
        console.error("Developer login error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error"
        });
    }
}

