import moment from "moment";

function calculateFutureDate(input: string): Date {
  const value = parseInt(input, 10);
  const unit = input.replace(/\d/g, "").toLowerCase(); // Extract the unit (d, mo)

  switch (unit) {
    case "d":
      return moment().add(value, "days").toDate();
    case "mo":
      return moment().add(value, "months").toDate();
    default:
      throw new Error(
        `Invalid unit: ${unit}. Use 'd' for days or 'mo' for months.`
      );
  }
}

export { calculateFutureDate };
