export { AppointmentServiceImpl } from "./application/appointment-service.js";
export type {
  AppointmentLookupError,
  AppointmentEditConflict,
  AppointmentCalendarQuery,
  AppointmentCalendarEntry,
  AppointmentService,
  CancelAppointmentCommand,
  CancelAppointmentError,
  CreateAppointmentCommand,
  CreateAppointmentError,
  GetAppointmentQuery,
  ListUpcomingAppointmentsQuery,
  ListAppointmentsQuery,
  MarkAppointmentOutcomeCommand,
  RescheduleAppointmentCommand,
  RescheduleAppointmentError,
} from "./application/contracts.js";
export type { Appointment, AppointmentStatus, AppointmentEvent } from "./domain/appointment.js";
export type { AppointmentRepository } from "./ports/appointment-repository.js";
export type {
  AppointmentCalendarError,
  AppointmentCalendarPort,
  AppointmentConcurrencyGuard,
  CustomerReader,
} from "./ports/appointment-dependencies.js";
export { InMemoryAppointmentRepository } from "./infrastructure/in-memory-appointment-repository.js";
export { InMemoryAppointmentConcurrencyGuard } from "./infrastructure/in-memory-appointment-concurrency-guard.js";
export { InMemoryAppointmentCalendar } from "./infrastructure/in-memory-appointment-calendar.js";

export { AppointmentOperationInProgressError } from "./ports/appointment-dependencies.js";
