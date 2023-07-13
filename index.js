const bodyParser = require("body-parser");
const express = require("express");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const tough = require("tough-cookie");
const http = require("http");
require("dotenv").config();
const {
  fetchIcon,
  authenticate,
  uploadImage,
  getIconID,
  getPermissions,
  getLanguages,
  getCountries,
  getCategory,
  createCMS,
} = require("./services/helpers/cms.js");
const { iconUploadTemplate, createTemplate } = require("./data/templates.js");

// Instance of an express Node Server
const server = express();

// Creates A REST API Endpoint
server.post("/", bodyParser.json(), async (req, res) => {
  await updateQueue(req.body, "In Progress");
  // Authenticate
  if (process.env.APIKEY !== req.headers["x-api-key"]) {
    await updateQueue(req.body, "Error");
    return res
      .status(403)
      .json({ message: "Not Authorized to Access This Endpoint" });
  }

  if (
    !req.body.hasOwnProperty("Records") ||
    !req.body.Records.length ||
    !req.body.Records[0].hasOwnProperty("body") ||
    !req.body.Records[0].hasOwnProperty("messageID")
  ) {
    await updateQueue(req.body, "Error");
    return res.status(400).json({ message: "Invalid request body" });
  }
  const result = await handler(req.body);
  //   await sendEmail(event);
  if (result.status === 201) {
    await updateQueue(req.body, "Created");
  } else {
    await updateQueue(req.body, "Error");
  }
  return res.status(result.status).json(result.message);
});

// Perpetual Server Listener
server.listen(3030, () => console.log("Listing to port 3030"));

const handler = async (event) => {
  // Program Starts
  console.log("Processing " + event.Records[0].messageID);

  // Check if Message Body Is Valid ie has an image to process
  if (
    !event.Records[0].body.hasOwnProperty("Body") ||
    !event.Records[0].body.hasOwnProperty("Icon") ||
    !event.Records[0].body.Icon.hasOwnProperty("Image") ||
    event.Records[0].body.Icon.Image.length < 1
  ) {
    return { status: 500, message: "No Image or Icon to Upload" };
  }
  return await createMicroApp(
    event.Records[0].body,
    event.Records[0].messageId
  );
};

async function sendEmail(event) {
  const nodemailer = require("nodemailer");
  const smtpTransport = require("nodemailer-smtp-transport");

  const transporter = nodemailer.createTransport(
    smtpTransport({
      service: "gmail",
      auth: {
        user: process.env.sesAccessKey,
        pass: process.env.sesSecretKey,
      },
    })
  );

  const text = JSON.stringify(event.Records[0]);

  const mailOptions = {
    from: "delali@thedigitalacademy.co.za",
    to: "dfunani@gmail.com",
    bcc: "delali@thedigitalacademy.co.za",
    subject: "Test subject",
    text: text,
  };
  console.log(process.env.sesAccessKey);
  transporter.sendMail(mailOptions, function (error, info) {
    if (error) {
      const response = {
        statusCode: 500,
        body: JSON.stringify({
          error: error.message,
        }),
      };
    }
    const response = {
      statusCode: 200,
      body: JSON.stringify({
        message: text,
      }),
    };
  });
}

async function createMicroApp(body, messageID) {
  // Create a new cookie jar
  let cookieJar = new tough.CookieJar();

  // Create a new instance of Axios
  let instance = await axios.create({
    jar: cookieJar,
    withCredentials: true,
    httpsAgent: new http.Agent({
      rejectUnauthorized: false,
      requestCert: true,
      keepAlive: true,
    }),
    headers: {
      "Content-Type": "application/vnd.api+json",
    },
  });

  // Getting Image from S3 Bucket provided by Strapi
  console.log("Fetching Icon - S3 Bucket...");
  let icon = await fetchIcon(body);
  if (!icon) return { status: 500, message: "Error: Couldn't fetch Icon" };

  // Get CSRF - For Session Management Cross Site Request Forgery
  console.log("Authenticating...");
  let res = await authenticate(instance);
  if (!res) return { status: 500, message: "Error: Couldn't Authenticate" };

  instance.defaults.headers["x-csrf-token"] = res.data;

  // Upload image to server
  console.log("Uploading Icon to DevCMS...");
  // Create Image ByteArray
  const imageBlob = new Uint8Array(icon.data);
  let image_upload = await uploadImage(imageBlob, body, instance);
  if (!image_upload)
    return { status: 500, message: "Error: Couldn't Upload Image" };

  // Populate the iconTemplate
  iconUploadTemplate.data.attributes.name = body.Icon.Image[0].name;
  iconUploadTemplate.data.relationships.field_media_image.data.id =
    image_upload.data.data.id;

  //  Retrieve Icon ID
  console.log("Confirming Icon Details on DevCMS...");
  let icon_id = await getIconID(iconUploadTemplate, instance);
  if (!icon_id) return { status: 500, message: "Error: Couldn't Get Icon ID" };

  // Create Permissions for Micro App
  console.log("Updating Permissions...");
  let permissions = await getPermissions();
  if (!permissions)
    return { status: 500, message: "Error: Couldn't Load Permissions" };

  // Updating Languages for the Create Micro App Request Body
  console.log("Updating Languages...");
  let languageIDS = await getLanguages(instance);
  if (!languageIDS)
    return { status: 500, message: "Error: Couldn't Load Languages" };

  // Update Countries
  console.log("Updating Countries...");
  let countryIDS = await getCountries(instance);
  if (!countryIDS)
    return { status: 500, message: "Error: Couldn't Load Countries" };

  // Update Categories
  console.log("Updating Categories...");
  let categoryIDS = await getCategory(instance);
  if (!categoryIDS)
    return { status: 500, message: "Error: Couldn't Load Categories" };

  updateCreateTemplate(
    body,
    icon_id,
    permissions,
    languageIDS,
    categoryIDS,
    countryIDS
  );

  // Create MicroApp on DevCMS
  console.log(JSON.stringify("Creating Micro App - DevCMS"));
  return await createCMS(createTemplate, messageID, instance);
}

const updateCreateTemplate = (
  body,
  icon_id,
  permissions,
  languageIDS,
  categoryIDS,
  countryIDS
) => {
  // Populate the Creation template
  createTemplate.data.attributes.title = body.Body.data.title;
  createTemplate.data.attributes.field_discovery_uri =
    body.Body.data.discoveryUri;
  createTemplate.data.attributes.field_chat_uri = body.Body.data.chatUri;
  createTemplate.data.attributes.body.value = body.Body.data.description;
  createTemplate.data.attributes.body.summary =
    body.Body.data.short_description;
  createTemplate.data.attributes.field_developer = body.Body.data.developer;

  createTemplate.data.relationships.field_image.data.id =
    icon_id.data.data.relationships.field_media_image.data.id;
  createTemplate.data.relationships.field_media_image.data.id =
    icon_id.data.data.id;

  // Populate the Creation Template with Permissions
  createTemplate.data.attributes.field_user_permissions = [...(new Set(
    permissions.data.data[0].attributes.permissions.permissions
      .filter((permission) => body.Body.data[permission.name])
      .map((obj) =>
        obj.name === "language" ||
        obj.name === "profile" ||
        obj.name === "presence"
          ? "User" +
            obj.name.slice(0, 1).toUpperCase() +
            obj.name.split(" ").join("").slice(1)
          : obj.name === "message"
          ? "Send" +
            obj.name.slice(0, 1).toUpperCase() +
            obj.name.split(" ").join("").slice(1)
          : obj.name === "msisdn"
          ? obj.name.toUpperCase()
          : obj.name === "ozow" || obj.name === "momo"
          ? "MoMoCollections"
          : obj.name.slice(0, 1).toUpperCase() +
            obj.name.split(" ").join("").slice(1)
      )
  ))];

  createTemplate.data.relationships.field_languages_term.data =
    languageIDS.data.data
      .filter((language) =>
        body.Body.data.languages
          .map((lang) => JSON.parse(lang.name))
          .flat()
          .includes(language.attributes.name)
      )
      .map((language) => {
        return { type: language.type, id: language.id };
      });

  // Populate Creation Template with Category Data
  createTemplate.data.relationships.field_category.data = categoryIDS.data.data
    .filter((category) =>
      JSON.parse(body.Body.data.category).includes(category.attributes.name)
    )
    .map((category) => {
      return { type: category.type, id: category.id };
    });

  // Populate Creation Template with Countries
  createTemplate.data.relationships.field_countries_term.data =
    countryIDS.data.data
      .filter((country) =>
        body.Body.data.countries
          .map((countryName) =>
            JSON.parse(countryName.name.split(" ").join(""))
          )
          .flat()
          .includes(country.attributes.name.split(" ").join(""))
      )
      .map((country) => {
        return { type: country.type, id: country.id };
      });

  console.log("Taxonomy Fields Updated");

  // Populating the Creation Template with Payments - MOMO
  console.log("Updating MoMo Payment...");
  createTemplate.data.attributes.field_momo = body.Body.data.momo;
  createTemplate.data.attributes.field_momo_phone = JSON.stringify(
    Object.values(body.Body.data.MomoCountries)
  );

  // Populating the Creation Template with Payments - OZOW
  console.log("Updating OZOW Payment...");
  createTemplate.data.attributes.field_ozow_pay = body.Body.data.ozow;
  createTemplate.data.attributes.field_contains_purchases =
    body.Body.data.billing;
  createTemplate.data.attributes.field_domains = body.Body.data.domains;
};

const updateQueue = async (body, status) => {
  if (body.hasOwnProperty("QueueID")) {
    let temp = await axios.put(
      "https://devstrapi.thedigitalacademy.co.za/api/voc-automation-messagelogs/" +
        body.QueueID.data.id,
      {
        data: {
          status: status,
        },
      }
    );
  }
};
