import bogOrCredoHandler from "./bog-pay.js";

// Dedicated Credo Bank Online Installment endpoint (/api/credo-pay) for Vercel
export default async function handler(req, res) {
  if (req.body && typeof req.body === "object") {
    req.body.bank = "credo";
  } else if (typeof req.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      parsed.bank = "credo";
      req.body = parsed;
    } catch (e) {}
  } else {
    req.body = { bank: "credo" };
  }
  return bogOrCredoHandler(req, res);
}
