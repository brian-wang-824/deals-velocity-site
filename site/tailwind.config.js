/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.html", "./public/**/*.js"],
  theme: {
    extend: {
      colors: {
        surge: "#dc2626",
        hot: "#ea580c",
        warm: "#ca8a04",
      },
    },
  },
  plugins: [],
};
