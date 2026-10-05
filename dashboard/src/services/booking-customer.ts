import { reactive } from "vue";
import { api, ApiError, type Customer } from "./api.js";

/** Small selection hook over the existing customer action; no profile/search store. */
export function createBookingCustomer(initial?: Customer, client = api.findOrCreateCustomer) {
  const state = reactive({ selected: initial, name: "", phone: "", busy: false, error: "" });
  async function choose() {
    if (state.busy) return;
    state.error = "";
    if (!state.phone.trim()) { state.error = "Enter the customer’s phone number."; return; }
    state.busy = true; state.selected = undefined;
    try {
      const customer = await client({ phone: state.phone.trim(), name: state.name.trim() });
      state.selected = customer;
      return customer;
    } catch (error) {
      state.error = error instanceof ApiError && error.code === "VALIDATION_ERROR"
        ? "Check the phone number and try again." : "The customer could not be selected. Check your access and try again.";
    } finally { state.busy = false; }
  }
  function clear() { if (!state.busy) { state.selected = undefined; state.name = ""; state.phone = ""; state.error = ""; } }
  return { state, choose, clear };
}
