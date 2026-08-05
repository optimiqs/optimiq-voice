type ObjectWithDates = {
  createdAt: Date;
  updatedAt: Date;
};

const datesMapper = <T extends ObjectWithDates>(item: T) => ({
  ...item,
  createdAt: item?.createdAt?.getTime() / 1000,
  updatedAt: item?.updatedAt?.getTime() / 1000
});

export { datesMapper };
