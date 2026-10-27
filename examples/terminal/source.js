export function shippingFee(orderTotal) {
  return orderTotal >= 1000 ? 0 : 99;
}
