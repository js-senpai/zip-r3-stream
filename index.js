const express = require("express");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const archiver = require("archiver");
require("dotenv").config();

const app = express();

const r2 = new S3Client({
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
  },
  region: process.env.CLOUDFLARE_REGION,
});

app.get("/photosession/:userId/:folderId/", async (req, res) => {
  const { userId, folderId } = req.params;
  const folderPath = `photosession/${userId}/${folderId}/`;

  try {
    console.log(`Start processing folder: ${folderPath}`);

    // Set headers for the zip download
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${folderId}.zip"`
    );

    // Create a zip archive with archiver
    const archive = archiver("zip", {
      zlib: { level: 0 }, // No compression
    });

    archive.on("error", (err) => {
      console.error("Archiver error:", err);
      if (!res.headersSent) {
        res.status(500).send(`Error creating ZIP: ${err.message}`);
      }
    });

    // Log when the stream has finished
    archive.on("finish", () => {
      console.log(`Zip stream finished for folder: ${folderPath}`);
    });

    // Listen for the 'close' event to detect request cancellations
    req.on("close", () => {
      console.log(`Request for ${folderPath} cancelled by client`);
      archive.abort(); // Aborts the archiving process
    });

    // Pipe the archive to the response
    archive.pipe(res);

    // Add files to the archive
    await addFilesToArchive(folderPath, archive, folderPath);

    // Finalize the archive
    await archive.finalize();
  } catch (error) {
    console.error("Error creating ZIP:", error);
    if (!res.headersSent) {
      res.status(500).send(`Error creating ZIP: ${error.message}`);
    }
  }
});

async function addFilesToArchive(folderPath, archive, rootFolderPath) {
  const listObjects = new ListObjectsV2Command({
    Bucket: process.env.CLOUDFLARE_BUCKET_NAME,
    Prefix: folderPath,
    Delimiter: "/",
  });

  const objects = await r2.send(listObjects);
  console.log(`Found ${objects.Contents.length} items in ${folderPath}`);

  // Process files in the current folder
  for (const object of objects.Contents) {
    if (!object.Key.endsWith("/")) {
      const relativeFileName = object.Key.slice(rootFolderPath.length); // Use rootFolderPath to get the relative path
      console.log(`Adding file to archive: ${relativeFileName}`);

      const getObject = new GetObjectCommand({
        Bucket: process.env.CLOUDFLARE_BUCKET_NAME,
        Key: object.Key,
      });

      const fileObject = await r2.send(getObject);

      if (fileObject && fileObject.Body) {
        // Append the file to the zip archive with its path relative to rootFolderPath
        archive.append(fileObject.Body, { name: relativeFileName });
      }
    }
  }

  // Handle subfolders by listing common prefixes
  if (objects.CommonPrefixes) {
    for (const prefix of objects.CommonPrefixes) {
      const subFolderPath = prefix.Prefix;
      console.log(`Entering subfolder: ${subFolderPath}`);

      // Recursively add files from subfolder
      await addFilesToArchive(subFolderPath, archive, rootFolderPath);
    }
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
