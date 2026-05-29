const { Router } = require("express");

const { isLoggedIn, isAuthenticated,
    authorize,
    isSubscriptionActive,
  } = require("../middlewares/auth.middleware");
  const { SCOPES } = require("../config/user.config");
const { getReports, getReportById } = require("../controllers/reports.controller");

const router = Router();

router.get("/", isLoggedIn, isAuthenticated, isSubscriptionActive, authorize([SCOPES.REPORTS]), getReports);
router.get("/:reportId", isLoggedIn, isAuthenticated, isSubscriptionActive, authorize([SCOPES.REPORTS]), getReportById);

module.exports = router;
