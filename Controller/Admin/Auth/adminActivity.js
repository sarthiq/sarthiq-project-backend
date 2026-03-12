const AdminActivity = require("../../../Models/User/adminActivity");
const {Op} =require('sequelize')


exports.getAdminActivityHistory = async (req, res, next) => {
  const { fromDate, toDate, limit, activityType } = req.body; // Extract filter parameters from request body
  const adminId = req.admin.id; // Get the admin's ID from req.admin
  
  try {
    // Prepare the filter conditions
    let whereConditions = { AdminId: adminId }; // AdminId must match the logged-in admin
    
    // Add activityType filter if provided and not 'All'
    if (activityType && activityType !== 'All') {
      whereConditions.activityType = activityType;
    }

    // Add date range filter if both fromDate and toDate are provided
    if (fromDate && toDate) {
      whereConditions.createdAt = {
        [Op.between]: [new Date(fromDate), new Date(toDate)] // Filter by date range
      };
    }

    // Set default limit to 20 if not provided
    const resultLimit = limit ? parseInt(limit) : 20;

    // Fetch admin activities with filters and order by most recent
    const adminActivities = await AdminActivity.findAll({
      where: whereConditions,
      order: [["createdAt", "DESC"]],
      limit: resultLimit,
    });

    // If no activities found
    if (adminActivities.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No activities found for the admin."
      });
    }

    // Respond with the activities
    res.status(200).json({
      success: true,
      data: adminActivities,
    });
  } catch (error) {
    console.error("Error fetching admin activity history:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching admin activity history."
    });
  }
};
