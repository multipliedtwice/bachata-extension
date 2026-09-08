export const slidingMaximum = (values: number[], window: number): number[] => {
  const result: number[] = [];
  for (let start = 0; start + window <= values.length; start += 1) {
    result.push(Math.max(...values.slice(start, start + window)));
  }
  return result;
};
