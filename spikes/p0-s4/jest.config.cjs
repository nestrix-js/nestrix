// Plain JavaScript tests, no transform: Jest's own module system does the require().
module.exports = {
  rootDir: __dirname,
  testMatch: ["<rootDir>/test/jest/**/*.jest.cjs"],
  transform: {},
  testEnvironment: "node",
};
