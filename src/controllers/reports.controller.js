const { getOrdersCountDB, getNewCustomerCountDB, getRepeatCustomerCountDB, getAverageOrderValueDB, getTotalCustomersDB, getTotalNetRevenueDB, getTotalTaxDB, getRevenueDB, getTopSellingItemsDB, getTotalPaymentsByPaymentTypesDB, getTotalServiceChargeDB, getReportByIdDB } = require("../services/reports.service")
const { getCurrencyDB } = require("../services/settings.service")

const validateReportQuery = (req, res) => {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const type = req.query.type;

    if(!type) {
        res.status(400).json({
            success: false,
            message: req.__("please_provide_required_details")
        });
        return null;
    }

    if(type == 'custom' && !(from && to)) {
        res.status(400).json({
            success: false,
            message: req.__("provide_from_to_dates")
        });
        return null;
    }

    return { from, to, type };
};

exports.getReports = async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;

        const query = validateReportQuery(req, res);
        if(!query) return;
        const { from, to, type } = query;

        const [ordersCount, newCustomers, repeatedCustomers, averageOrderValue, totalCustomers, netRevenue, taxTotal, serviceChargeTotal,  revenueTotal, topSellingItems, totalPaymentsByPaymentTypes, currency] = await Promise.all([
            getOrdersCountDB(type, from, to, tenantId),
            getNewCustomerCountDB(type, from, to, tenantId),
            getRepeatCustomerCountDB(type, from, to, tenantId),
            getAverageOrderValueDB(type, from, to, tenantId),
            getTotalCustomersDB(tenantId),
            getTotalNetRevenueDB(type, from, to, tenantId),
            getTotalTaxDB(type, from, to, tenantId),
            getTotalServiceChargeDB(type, from, to, tenantId),
            getRevenueDB(type, from, to, tenantId),
            getTopSellingItemsDB(type, from, to, tenantId),
            getTotalPaymentsByPaymentTypesDB(type, from, to, tenantId),
            getCurrencyDB(tenantId),
        ]);

        return res.status(200).json({
            ordersCount, newCustomers, repeatedCustomers, currency, averageOrderValue, totalCustomers, netRevenue, taxTotal, serviceChargeTotal, revenueTotal, topSellingItems, totalPaymentsByPaymentTypes
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: req.__("something_went_wrong_try_later") // Translate message
        });
    }
};

exports.getReportById = async (req, res) => {
    try {
        const tenantId = req.user.tenant_id;
        const reportId = req.params.reportId;

        const query = validateReportQuery(req, res);
        if(!query) return;
        const { from, to, type } = query;

        const report = await getReportByIdDB(reportId, type, from, to, tenantId);
        return res.status(200).json(report);
    } catch (error) {
        console.error(error);
        return res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode === 404 ? "Report not found" : req.__("something_went_wrong_try_later")
        });
    }
};
