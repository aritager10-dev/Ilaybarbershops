// Seed configuration, used until the admin saves. Contains no customer data.
module.exports = {
  siteConfig: {
    title: "ILAY BARBERSHOP",
    subtitle: "תספורת נקייה, אווירה טובה וסטייל שיושב בול.",
    slotInterval: 30,
    slotBuffer: 0,
    reminderHoursBefore: 3,
    smsPackageQuota: 1500,
    barberPhone: "0542858711"
  },
  services: [
    { name: "תספורת קלאסי", price: 70, duration: "30 דק'", desc: "דירוג (מולט, טייפר, בארסט ועוד..) עם גזירות ואפשרות להוסיף פנס לבחירה." },
    { name: "תספורת מוגזם", price: 90, duration: "45 דק'", desc: "לא הסתפרת הרבה זמן ורוצה לעשות שינוי, תספורת גזירות מלאה." },
    { name: "תספורת קלאסי + זקן", price: 80, duration: "35 דק'", desc: "דירוג נקי (מולט, טייפר, בארסט ועוד) עם גזירות, פנס לבחירה וסידור זקן מדויק." },
    { name: "תספורת מוגזם + זקן", price: 100, duration: "50 דק'", desc: "שינוי לוק מלא בגזירות ודירוג למי שלא הסתפר הרבה זמן, כולל עיצוב וסידור זקן." }
  ],
  // Number of DEFAULT_PORTFOLIO images in core.js; portfolio entries "def:N" refer to them.
  defaultPhotoCount: 5
};
