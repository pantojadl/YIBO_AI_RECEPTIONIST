import { failure, success } from "../../../shared/domain/result.js";
import type { IANATimeZone, TenantId } from "../../../shared/types/identifiers.js";
import {
  normalizePhoneNumber,
  validateBusinessProfile,
} from "../domain/validate-business-profile.js";
import { upgradeBusinessProfile } from "../domain/upgrade-business-profile.js";
import type {
  BusinessDirectory,
  BusinessLookupError,
  BusinessProfile,
  EditableBusinessConfiguration,
  VersionedBusinessConfiguration,
} from "./contracts.js";
import type { BusinessRepository } from "../ports/business-repository.js";

export class BusinessDirectoryService implements BusinessDirectory {
  constructor(private readonly repository: BusinessRepository) {}

  async resolveLocationByCalledNumber(phoneNumber: string) {
    const calledNumber = normalizePhoneNumber(phoneNumber);
    if (!calledNumber) return failure<BusinessLookupError>({ code: "INVALID_CALLED_NUMBER" });
    const profile = await this.repository.findByCalledNumber(calledNumber);
    const business = this.toLookupResult(profile);
    if (!business.ok) return business;
    const upgraded = upgradeBusinessProfile(business.value);
    const location = upgraded.locations.find((candidate) => candidate.active
      && candidate.calledNumbers.some((number) => normalizePhoneNumber(number) === calledNumber));
    return location
      ? success({ tenantId: upgraded.tenantId, locationId: location.id, business: upgraded, location })
      : failure<BusinessLookupError>({ code: "LOCATION_NOT_FOUND" });
  }

  async getLocation(tenantId: TenantId, locationId: string) {
    const business = this.toLookupResult(await this.repository.findByTenantId(tenantId));
    if (!business.ok) return business;
    const upgraded = upgradeBusinessProfile(business.value);
    const location = upgraded.locations.find((candidate) => candidate.id === locationId && candidate.active);
    return location
      ? success({ tenantId: upgraded.tenantId, locationId: location.id, business: upgraded, location })
      : failure<BusinessLookupError>({ code: "LOCATION_NOT_FOUND" });
  }

  async getBusinessByCalledNumber(phoneNumber: string) {
    const calledNumber = normalizePhoneNumber(phoneNumber);
    if (!calledNumber) return failure<BusinessLookupError>({ code: "INVALID_CALLED_NUMBER" });

    return this.toLookupResult(await this.repository.findByCalledNumber(calledNumber));
  }

  async getBusinessProfile(tenantId: TenantId) {
    return this.toLookupResult(await this.repository.findByTenantId(tenantId));
  }

  async updateBusinessTimezone(tenantId: TenantId, timezone: IANATimeZone) {
    const stored = await this.repository.findByTenantId(tenantId);
    if (!stored) return failure<BusinessLookupError>({ code: "BUSINESS_NOT_FOUND" });
    let profile;
    try { profile = upgradeBusinessProfile(stored); } catch (error) {
      return failure<BusinessLookupError>({
        code: "BUSINESS_CONFIGURATION_INVALID",
        message: error instanceof Error ? error.message : "Invalid business configuration",
      });
    }
    const location = profile.locations.find(({ id }) => id === "default") ?? profile.locations[0];
    if (!location) return failure<BusinessLookupError>({ code: "LOCATION_NOT_FOUND" });
    const updated = {
      ...profile,
      locations: profile.locations.map((candidate) =>
        candidate.id === location.id ? { ...candidate, timezone } : candidate),
    };
    try { upgradeBusinessProfile(updated); } catch (error) {
      return failure<BusinessLookupError>({
        code: "BUSINESS_CONFIGURATION_INVALID",
        message: error instanceof Error ? error.message : "Invalid business configuration",
      });
    }
    await this.repository.save(updated);
    return success(updated);
  }

  async getBusinessConfiguration(tenantId: TenantId) {
    const stored = await this.repository.findConfigurationByTenantId(tenantId);
    if (!stored) return failure<BusinessLookupError>({ code: "BUSINESS_NOT_FOUND" });
    const profile = this.upgradeForAdministration(stored.profile);
    return profile.ok
      ? success(toVersionedConfiguration(profile.value, stored.version))
      : profile;
  }

  async updateBusinessConfiguration(
    tenantId: TenantId,
    configuration: EditableBusinessConfiguration,
    expectedVersion: number,
  ) {
    const stored = await this.repository.findConfigurationByTenantId(tenantId);
    if (!stored) return failure<BusinessLookupError>({ code: "BUSINESS_NOT_FOUND" });
    const current = this.upgradeForAdministration(stored.profile);
    if (!current.ok) return current;
    const candidate = {
      ...structuredClone(configuration),
      schemaVersion: 2 as const,
      region: current.value.region,
      tenantId: current.value.tenantId,
      businessId: current.value.businessId,
    };
    const validated = this.upgradeForAdministration(candidate);
    if (!validated.ok) return validated;
    const saved = await this.repository.saveIfVersion(validated.value, expectedVersion);
    if (!saved.saved && saved.reason) return failure<BusinessLookupError>({ code: saved.reason });
    return saved.saved
      ? success(toVersionedConfiguration(validated.value, saved.version))
      : failure<BusinessLookupError>({
          code: "CONFIGURATION_VERSION_CONFLICT",
          currentVersion: saved.currentVersion,
        });
  }

  private upgradeForAdministration(
    stored: import("../domain/upgrade-business-profile.js").VersionedBusinessProfile,
  ) {
    try {
      return success(upgradeBusinessProfile(stored));
    } catch (error) {
      return failure<BusinessLookupError>({
        code: "BUSINESS_CONFIGURATION_INVALID",
        message: error instanceof Error ? error.message : "Invalid business configuration",
      });
    }
  }

  private toLookupResult(profile: import("../domain/upgrade-business-profile.js").VersionedBusinessProfile | null) {
    if (!profile) return failure<BusinessLookupError>({ code: "BUSINESS_NOT_FOUND" });
    if (!profile.active) return failure<BusinessLookupError>({ code: "BUSINESS_INACTIVE" });

    if (profile.schemaVersion !== 2) {
      const validationError = validateBusinessProfile(profile);
      if (validationError) {
        return failure<BusinessLookupError>({
          code: "BUSINESS_CONFIGURATION_INVALID",
          message: validationError.message,
        });
      }
    }
    try {
      return success(upgradeBusinessProfile(profile));
    } catch (error) {
      return failure<BusinessLookupError>({
        code: "BUSINESS_CONFIGURATION_INVALID",
        message: error instanceof Error ? error.message : "Invalid business configuration",
      });
    }
  }
}

const toVersionedConfiguration = (
  profile: import("../domain/multi-location-business.js").BusinessConfigurationV2,
  version: number,
): VersionedBusinessConfiguration => ({
  version,
  region: profile.region,
  businessId: profile.businessId,
  configuration: {
    ...(profile.displayCurrency === undefined ? {} : { displayCurrency: profile.displayCurrency }),
    name: profile.name,
    active: profile.active,
    services: structuredClone(profile.services),
    professionals: structuredClone(profile.professionals),
    locations: structuredClone(profile.locations),
  },
});
