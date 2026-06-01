const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { CONFIG } = require("../config");

const PUBLIC_DIR = path.resolve(__dirname, "../../public");

const MIME_TO_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
};

let s3Client;

const isS3Storage = () => CONFIG.STORAGE_DRIVER === "s3";

const withS3Prefix = (key) => {
    const prefix = CONFIG.S3_PREFIX;
    if (!prefix) {
        return key;
    }
    return `${prefix}/${key}`;
};

const getS3Client = () => {
    if (!s3Client) {
        const clientConfig = { region: CONFIG.AWS_REGION };

        if (CONFIG.AWS_ACCESS_KEY_ID && CONFIG.AWS_SECRET_ACCESS_KEY) {
            clientConfig.credentials = {
                accessKeyId: CONFIG.AWS_ACCESS_KEY_ID,
                secretAccessKey: CONFIG.AWS_SECRET_ACCESS_KEY,
            };
        }

        s3Client = new S3Client(clientConfig);
    }

    return s3Client;
};

const assertS3Configured = () => {
    if (!CONFIG.S3_BUCKET_NAME) {
        throw new Error("S3_BUCKET_NAME is required when STORAGE_DRIVER=s3");
    }
    if (!CONFIG.ASSETS_PUBLIC_BASE_URL) {
        throw new Error("ASSETS_PUBLIC_BASE_URL is required when STORAGE_DRIVER=s3");
    }
};

exports.validateImageFile = (file) => {
    if (!file) {
        return { valid: false, message: "image_file_required" };
    }

    const allowedMime = Object.keys(MIME_TO_EXT);
    if (!allowedMime.includes(file.mimetype)) {
        return { valid: false, message: "invalid_image_type" };
    }

    return { valid: true };
};

const getFileExtension = (file) => {
    if (file.name) {
        const ext = path.extname(file.name).toLowerCase();
        if (ext && Object.values(MIME_TO_EXT).includes(ext)) {
            return ext;
        }
    }

    return MIME_TO_EXT[file.mimetype] || "";
};

exports.buildPublicUrl = (key) => {
    const base = CONFIG.ASSETS_PUBLIC_BASE_URL.replace(/\/$/, "");
    return `${base}/${key}`;
};

exports.keyFromUrl = (url) => {
    if (!url || typeof url !== "string") {
        return null;
    }

    const base = CONFIG.ASSETS_PUBLIC_BASE_URL.replace(/\/$/, "");
    if (url.startsWith(`${base}/`)) {
        return url.slice(base.length + 1);
    }

    if (CONFIG.S3_BUCKET_NAME) {
        try {
            const parsed = new URL(url);
            const host = parsed.hostname;

            if (
                host === `${CONFIG.S3_BUCKET_NAME}.s3.${CONFIG.AWS_REGION}.amazonaws.com` ||
                host === `${CONFIG.S3_BUCKET_NAME}.s3.amazonaws.com` ||
                host === `s3.${CONFIG.AWS_REGION}.amazonaws.com`
            ) {
                const pathname = parsed.pathname.replace(/^\//, "");
                if (pathname.startsWith(`${CONFIG.S3_BUCKET_NAME}/`)) {
                    return pathname.slice(CONFIG.S3_BUCKET_NAME.length + 1);
                }
                return pathname || null;
            }
        } catch {
            return null;
        }
    }

    return null;
};

const getLocalPathFromUrl = (url) => {
    if (!url?.startsWith("/public/")) {
        const base = CONFIG.ASSETS_PUBLIC_BASE_URL.replace(/\/$/, "");
        if (url?.startsWith(`${base}/public/`)) {
            return path.join(PUBLIC_DIR, url.slice(`${base}/public/`.length));
        }
        return null;
    }

    return path.join(PUBLIC_DIR, url.replace("/public/", ""));
};

const uploadToLocal = async (file, key) => {
    const ext = getFileExtension(file);
    const fullKey = ext && !key.endsWith(ext) ? `${key}${ext}` : key;
    const publicRelative = fullKey.replace(/^tenants\//, "");
    const destination = path.join(PUBLIC_DIR, publicRelative);
    const dirPath = path.dirname(destination);

    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    await file.mv(destination);

    const base = CONFIG.ASSETS_PUBLIC_BASE_URL.replace(/\/$/, "");
    return `${base}/public/${publicRelative}`;
};

const uploadToS3 = async (file, key) => {
    assertS3Configured();

    const ext = getFileExtension(file);
    const objectKey = ext && !key.endsWith(ext) ? `${key}${ext}` : key;
    const fullKey = withS3Prefix(objectKey);
    const body = file.tempFilePath
        ? fs.createReadStream(file.tempFilePath)
        : file.data;

    await getS3Client().send(
        new PutObjectCommand({
            Bucket: CONFIG.S3_BUCKET_NAME,
            Key: fullKey,
            Body: body,
            ContentType: file.mimetype,
        })
    );

    return exports.buildPublicUrl(fullKey);
};

exports.uploadImage = async (file, key) => {
    if (isS3Storage()) {
        return uploadToS3(file, key);
    }

    return uploadToLocal(file, key);
};

const deleteFromLocal = async (url) => {
    const filePath = getLocalPathFromUrl(url);
    if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
};

const deleteFromS3 = async (url) => {
    assertS3Configured();

    const key = exports.keyFromUrl(url);
    if (!key) {
        return;
    }

    await getS3Client().send(
        new DeleteObjectCommand({
            Bucket: CONFIG.S3_BUCKET_NAME,
            Key: key,
        })
    );
};

exports.deleteImageByUrl = async (url) => {
    if (!url) {
        return;
    }

    if (isS3Storage()) {
        await deleteFromS3(url);
        return;
    }

    await deleteFromLocal(url);
};

exports.buildMenuItemImageKey = (tenantId, menuItemId) =>
    `tenants/${tenantId}/menu-items/${menuItemId}`;

exports.buildStoreImageKey = (tenantId, uniqueId) =>
    `tenants/${tenantId}/store/${uniqueId}`;
