const { getUserDB } = require("../services/user.service");
const { verifyToken, generateAccessToken, generateRefreshToken } = require("../utils/jwt");
const { ROLES } = require("../config/user.config");
const { getAdminUserDB } = require("../services/superadmin.service");
const { getTenantById, addRefreshTokenDB } = require("../services/auth.service");
const { CONFIG } = require("../config");

exports.isLoggedIn = (req, res, next) => {
    let token;
   

    if(req.cookies.accessToken || 
        (req.headers.authorization && req.headers.authorization.startsWith('Bearer'))
    ) {
        token = req.cookies.accessToken || req.headers.authorization.split(" ")[1];
    }

    if(!token) {
        return res.status(401).json({
            success: false,
            message: req.__("login_again_to_access")
        });
    }
    req.token = token;
    next();
} 

exports.isAuthenticated = async (req, res, next) => {
  try {
    const accessToken = req.token || req.cookies.accessToken;
    if (!accessToken) throw new Error("No token");

    let decoded = verifyToken(accessToken);  
    
    // if(decoded.tenant_id){
    //      const tenant = await getTenantById(decoded.tenant_id);
    //     if (!tenant) throw new Error("Tenant not found");

    //     if (decoded.tokenVersion !== tenant.token_version) {
    //       throw new Error("Token version mismatch");
    //     }
    // }
    
   

    // if(decoded.tenant_id) {
    //     const tenant = await getTenantById(decoded.tenant_id);
    //     if (!tenant) throw new Error("Tenant not found");

    //     console.log('Token version:', decoded.tokenVersion, 'Tenant token version:', tenant.token_version);
    //     // 🔄 Token outdated → refresh silently
    //     if (decoded.tokenVersion !== tenant.token_version) {
    //       const user = await getUserDB(decoded.username, decoded.tenant_id);

    //       const payload = {
    //         tenant_id: user.tenant_id,
    //         username: user.username,
    //         name: user.name,
    //         role: user.role,
    //         is_active: user.is_active,
    //         tokenVersion: tenant.token_version,
    //       };

    //       const newAccessToken = generateAccessToken(payload);
    //       const newRefreshToken = generateRefreshToken(payload);

    //       console.log(newAccessToken);
    //       console.log("refreshtoken",newRefreshToken);

    //       const cookieOptions = {
    //         expires: new Date(Date.now() + Number(CONFIG.COOKIE_EXPIRY)),
    //         httpOnly: true,
    //         domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
    //         sameSite: false,
    //         secure: process.env.NODE_ENV === "production",
    //         path: "/",
    //       };


    //       const refreshTokenExpiry = new Date(
    //         Date.now() + Number(CONFIG.COOKIE_EXPIRY_REFRESH)
    //       );



    //       res.cookie("accessToken", newAccessToken, cookieOptions);
    //       res.cookie("refreshToken", newRefreshToken, {
    //         ...cookieOptions,
    //         expires: refreshTokenExpiry,
    //       });

    //       const deviceIP = req.connection.remoteAddress;
    //       const deviceName = `${deviceDetails.platform}\nBrowser: ${deviceDetails.browser}`;
    //       const deviceLocation = "";
    //       await addRefreshTokenDB(user.username, newRefreshToken, refreshTokenExpiry, deviceIP, deviceName, deviceLocation, user.tenant_id);

    //       // ✅ update decoded user
    //       req.user = payload;
    //       return next();
    //     }
    // }
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: req.__("operation_not_allowed"),
    });
  }
};


exports.isSubscriptionActive = async (req, res, next) => {
    const user = req.user;

    // Fetch fresh tenant/subscription info
    const tenant = await getTenantById(user.tenant_id);
    if(tenant?.is_active == 1) {
        return next();
    } else {
        return res.status(402).json({
            success: false,
            message: req.__("subscription_cancelled_no_longer_charged")
        });
    }
};

exports.hasRefreshToken = (req, res, next) => {
    const token =
        req.cookies.refreshToken ||
        req.headers["x-refresh-token"] ||
        req.body?.refreshToken;

    if(!token) {
        return res.status(401).json({
            success: false,
            message: req.__("login_again_to_access")
        });
    }
    try {
        const decodedToken = verifyToken(token);
        req.user = decodedToken;
        req.refreshToken = token;

        next();
    } catch (error) {
        console.error(error);

        res.clearCookie('accessToken',{
            expires: new Date(Date.now() ),
            httpOnly: true,
            domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
            sameSite: false,
            secure: process.env.NODE_ENV == "production",
            path: "/"
        });
        res.clearCookie('refreshToken', {
            expires: new Date(Date.now()),
            httpOnly: true,
            domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
            sameSite: false,
            secure: process.env.NODE_ENV == "production",
            path: "/"
        }); 
        res.clearCookie('kadeshfood__authenticated', {
            expires: new Date(Date.now()),
            domain: CONFIG.FRONTEND_DOMAIN_COOKIE,
            sameSite: false,
            secure: process.env.NODE_ENV == "production",
            path: "/"
        });

        return res.status(401).json({
            success: false,
            message: req.__("operation_not_allowed")
        });
    }
} 

exports.authorize = (requiredScopes) => {
    return async (req, res, next) => {
        try {
            // const {username, scope: userScopes, tenant_id} = req.user;
            const {username,  tenant_id, planFeatures,  scope: userScopes} = req.user;
        
            const user = await getUserDB(username, tenant_id);
            console.log("User fetched for authorization:", user.plan_features);


            // const isSame =
            //   Array.isArray(user.plan_features) &&
            //   Array.isArray(planFeatures) &&
            //   user.plan_features.length === planFeatures.length &&
            //   user.plan_features.every((f, i) => f === planFeatures[i]);

            // if (!isSame) {
            //   return res.status(403).json({
            //     success: false,
            //     message: req.__("operation_not_allowed"),
            //   });
            // }

            const userPlanScopesArr = user?.plan_features || [];
            // const userScopes = user?.scope || "";

            const hasAccess = requiredScopes.some((scope)=> userPlanScopesArr.includes(scope));

            if(!hasAccess) {
                return res.status(403).json({
                    success: false, 
                    message: req.__("operation_not_allowed")
                });
            }

            if(!user) {
                return res.status(401).json({
                    success: false, 
                    message: req.__("operation_not_allowed")
                });
            }

            if(user.role == ROLES.ADMIN) {
                return next();
            }

            // const isSameScope =
            //   user.scope?.length === userScopes?.length &&
            //   user.scope.every(s => userScopes.includes(s));

            // if (!isSameScope) {
            //   return res.status(403).json({
            //     success: false,
            //     message: req.__("operation_not_allowed"),
            //   });
            // }

            const userScopesArr = user?.scope?.split(",")?.map(s=>s.trim());

            const isOperationAllowed = requiredScopes.some((scope)=>userScopesArr.includes(scope));

            if(!isOperationAllowed) {
                return res.status(403).json({
                    success: false, 
                    message: req.__("operation_not_allowed")
                });
            }
            next();

        } catch (error) {
            console.error(error);
            return res.status(500).json({
                success: false,
                message: req.__("something_went_wrong_try_later")
            });
        }
    };
}

exports.isSuperAdmin = async (req, res, next) => {
    try {
        const {username, role} = req.user;
    
        const user = await getAdminUserDB(username);

        if(!user) {
            return res.status(401).json({
                success: false, 
                message: req.__("operation_not_allowed")
            });
        }

        next();

    } catch (error) {
        console.error(error);
        return res.status(500).json({
            success: false,
            message: req.__("something_went_wrong_try_later")
        });
    }
}
