const mongoose = require('mongoose');

// Money the company has ready to pay salaries for one pay period (see the Salary summary page).
// key = the pay period key: YYYY-MM or YYYY-MM-DD..YYYY-MM-DD (utils/period.js)
const salaryFundsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    cash: { type: Number, min: 0, default: 0 }, // cash in hand
    bank: { type: Number, min: 0, default: 0 }, // balance in the bank
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SalaryFunds', salaryFundsSchema);
