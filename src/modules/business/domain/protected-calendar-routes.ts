import type { BusinessConfigurationV2 } from "./multi-location-business.js";

export interface CalendarRouteReference { locationId: string; employeeId: string }

/** Preserve effective IDs and resolver access, not override/fallback source. */
export function changesBookedCalendarRoute(
  before: BusinessConfigurationV2,
  after: BusinessConfigurationV2,
  references: readonly CalendarRouteReference[],
): boolean {
  const calendar = (profile: BusinessConfigurationV2, reference: CalendarRouteReference) => {
    const location = profile.locations.find(({ id }) => id === reference.locationId);
    const professional = location?.professionals.find(({ professionalId }) => professionalId === reference.employeeId);
    const id = professional ? professional.calendarId?.trim() || location?.defaultCalendarId?.trim() || undefined : undefined;
    return { id, accessible: !!(id && profile.active && location?.active && professional?.active) };
  };
  return references.some(reference => {
    const previous = calendar(before, reference);
    const next = calendar(after, reference);
    // Reactivation of an already-disabled route is safe when its ID stays the same.
    return previous.id !== next.id || (previous.accessible && !next.accessible);
  });
}
