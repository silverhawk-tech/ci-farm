// The services an agent may ask to have restarted. ci-egress (the firewall rule) is deliberately NOT here: stopping or restarting it
// removes a protection, so only a human with sudo touches it.
export const SERVICES = { controld: 'ci-controld.service', broker: 'ci-broker.service', auditd: 'ci-auditd.service' } as const;
export type Service = keyof typeof SERVICES;
export const SERVICE_NAMES = Object.keys(SERVICES) as [Service, ...Service[]];
