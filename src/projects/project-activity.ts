import { ProjectActivityType } from '../generated/prisma/enums';

type Details = Record<string, unknown>;

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value : fallback;

/** Human-readable feed line (same wording as the old frontend). */
export function describeActivity(
  type: ProjectActivityType,
  details: Details,
): string {
  switch (type) {
    case ProjectActivityType.VIEW:
      return 'viewed the project';
    case ProjectActivityType.EDIT:
      return details.step_name
        ? `edited ${text(details.step_name, 'the project')}`
        : 'made changes';
    case ProjectActivityType.SHARE:
      return 'shared the project';
    case ProjectActivityType.INVITE:
      return `invited ${text(details.email, 'someone')}`;
    case ProjectActivityType.COMMENT:
      return 'added a comment';
    case ProjectActivityType.CREATE:
      return 'created the project';
    case ProjectActivityType.DELETE:
      return 'deleted the project';
    case ProjectActivityType.RENAME:
      return `renamed to "${text(details.new_name, 'Untitled')}"`;
    case ProjectActivityType.DUPLICATE:
      return 'duplicated the project';
    case ProjectActivityType.EXPORT:
      return 'exported the project';
    case ProjectActivityType.ACCESS_GRANTED:
      return `granted ${text(details.role, 'access')} to ${text(details.email, 'someone')}`;
    case ProjectActivityType.ACCESS_REVOKED:
      return `revoked access from ${text(details.email, 'someone')}`;
    case ProjectActivityType.ROLE_CHANGED:
      return `changed role to ${text(details.new_role, 'unknown')}`;
    default:
      return 'performed an action';
  }
}
