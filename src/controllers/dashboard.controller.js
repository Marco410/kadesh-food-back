const {
    getTodaysTopSellingItemsDB,
    getTodaysOrdersCountDB,
    getTodaysNewCustomerCountDB,
    getTodaysRepeatCustomerCountDB,
    getTodaysRevenueDB,
    getYesterdaysRevenueDB,
    getYesterdaysOrdersCountDB,
    getYesterdaysNewCustomerCountDB,
    getRevenueTrendDB,
    getSalesByHourDB,
    getOrdersByTypeDB,
    getPaymentMixDB,
    getLowStockAlertsDB,
    getRecentFeedbackDB,
    getCancelledOrdersCountDB,
} = require("../services/dashboard.service");
const { getReservationsDB } = require("../services/reservation.service");
const { getCurrencyDB } = require("../services/settings.service");

exports.getDashboardData = async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        
        const [
            reservations,
            topSellingItems,
            ordersCount,
            newCustomerCount,
            repeatedCustomerCount,
            currency,
            // New analytics data
            todayRevenue,
            yesterdayRevenue,
            yesterdayOrders,
            yesterdayNewCustomers,
            revenueTrend,
            salesByHour,
            ordersByType,
            paymentMix,
            lowStockAlerts,
            recentFeedback,
            cancelledOrders,
        ] = await Promise.all([
            getReservationsDB("today", null, null, tenantId),
            getTodaysTopSellingItemsDB(tenantId),
            getTodaysOrdersCountDB(tenantId),
            getTodaysNewCustomerCountDB(tenantId),
            getTodaysRepeatCustomerCountDB(tenantId),
            getCurrencyDB(tenantId),
            // New analytics queries
            getTodaysRevenueDB(tenantId),
            getYesterdaysRevenueDB(tenantId),
            getYesterdaysOrdersCountDB(tenantId),
            getYesterdaysNewCustomerCountDB(tenantId),
            getRevenueTrendDB(tenantId),
            getSalesByHourDB(tenantId),
            getOrdersByTypeDB(tenantId),
            getPaymentMixDB(tenantId),
            getLowStockAlertsDB(tenantId),
            getRecentFeedbackDB(tenantId),
            getCancelledOrdersCountDB(tenantId),
        ]);

        return res.status(200).json({
            // Existing data (backward compatible)
            reservations,
            topSellingItems,
            ordersCount,
            newCustomerCount,
            repeatedCustomerCount,
            currency,
            // New analytics data
            todayRevenue,
            yesterdayRevenue,
            yesterdayOrders,
            yesterdayNewCustomers,
            revenueTrend,
            salesByHour,
            ordersByType,
            paymentMix,
            lowStockAlerts,
            recentFeedback,
            cancelledOrders,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: req.__("something_went_wrong_try_later") // Translate message
        });
    }
};
