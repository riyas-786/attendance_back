const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const users = [
    { name: 'Admin', email: 'admin@company.com', password: 'Admin@123', role: 'admin', employeeId: 'E001', department: 'HR' },
    { name: 'Sara Ahmed', email: 'sara@company.com', password: 'Staff@123', role: 'staff', employeeId: 'E002', department: 'Sales', baseSalary: 8000 },
    { name: 'Omar Khan', email: 'omar@company.com', password: 'Staff@123', role: 'staff', employeeId: 'E003', department: 'IT', baseSalary: 9000 },
  ];

  for (const u of users) {
    if (!(await User.findOne({ email: u.email }))) {
      await User.create(u);
      console.log('Created', u.email);
    }
  }
  await mongoose.disconnect();
  console.log('Seed done. Change these passwords before going live.');
})();
