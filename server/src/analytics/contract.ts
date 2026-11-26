/** Shared allowlist. No free text, DOM content, URLs, entity IDs, or questionnaire answers. */
export const ANALYTICS_PRIVACY_VERSION = '2026-11-19';
export const SCREENS = ['map','people','meetups','places','news','games','profile','registration'] as const;
export type AnalyticsScreen = typeof SCREENS[number];
export const NOTICE_KINDS = ['bot','username','meetup','create','wish','poll','author','serial','buddy','profile','pin','nearby','safety'] as const;
export type AnalyticsNotice = typeof NOTICE_KINDS[number];
export const DONATION_METHODS = ['card','erip','phone','stars'] as const;
export type AnalyticsDonationMethod = typeof DONATION_METHODS[number];
export const ELEMENTS = [
  'nav_map','nav_people','nav_meetups','nav_places','nav_news','nav_games','nav_profile',
  'people_filters','meetup_create','meetup_join','person_wave','chat_open',
  'profile_save','profile_questionnaire','profile_help','profile_donate',
  'invite_continue','invite_later','map_donate','donation_checkout','place_save','wish_create'
] as const;
export type AnalyticsElement = typeof ELEMENTS[number];
export const CLIENT_EVENTS = [
  'gulyai_screen_viewed','gulyai_screen_active','gulyai_element_seen','gulyai_element_clicked',
  'gulyai_person_opened','gulyai_meetup_opened','gulyai_place_opened','gulyai_filters_opened','gulyai_filters_applied',
  'gulyai_questionnaire_started','gulyai_profile_invite_shown','gulyai_profile_invite_later','gulyai_profile_invite_continue',
  'gulyai_donation_opened','gulyai_donation_checkout','gulyai_chat_opened',
  'gulyai_donation_methods_opened','gulyai_donation_details_clicked','gulyai_donation_self_reported',
  'gulyai_map_live_status_clicked',
  'gulyai_notice_seen','gulyai_notice_clicked','gulyai_notice_dismissed'
] as const;
export const SERVER_EVENTS = [
  'gulyai_profile_saved','gulyai_questionnaire_saved','gulyai_questionnaire_completed',
  'gulyai_meetup_created','gulyai_meetup_signup_saved','gulyai_meetup_joined','gulyai_meetup_join_requested','gulyai_wave_sent','gulyai_connection_created',
  'gulyai_place_saved','gulyai_meetup_form_opened','gulyai_meetup_form_template','gulyai_meetup_form_published','gulyai_meetup_form_closed','gulyai_meetup_form_error'
] as const;
export type ClientEventName = typeof CLIENT_EVENTS[number];
export type ServerEventName = typeof SERVER_EVENTS[number];
export interface AnalyticsProperties {
  screen?: AnalyticsScreen;
  element?: AnalyticsElement;
  active_ms?: number;
  filters_count?: number;
  answered_count?: number;
  completed?: boolean;
  notice_kind?: AnalyticsNotice;
  notice_placement?: 'bottom' | 'help';
  entry_point?: 'bottom_notice';
  donation_method?: AnalyticsDonationMethod;
}
export interface ClientAnalyticsEvent { id: string; event: ClientEventName; session_id: string; at: number; properties: AnalyticsProperties; }
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SCREEN_LABELS: Record<AnalyticsScreen,string> = {map:'Карта',people:'Люди',meetups:'Сходки',places:'Места',news:'Новости',games:'Игры',profile:'Я',registration:'Регистрация'};
export const ELEMENT_LABELS: Record<AnalyticsElement,string> = {
 nav_map:'Вкладка Карта',nav_people:'Вкладка Люди',nav_meetups:'Вкладка Сходки',nav_places:'Вкладка Места',nav_news:'Вкладка Новости',nav_games:'Вкладка Игры',nav_profile:'Вкладка Я',
 people_filters:'Фильтры людей',meetup_create:'Создать сходку',meetup_join:'Записаться на сходку',person_wave:'Отправить привет',chat_open:'Открыть переписку',
 profile_save:'Сохранить анкету',profile_questionnaire:'Подробные вопросы',profile_help:'Как работает приложение',profile_donate:'Поддержать проект',
 invite_continue:'Баннер: дополнить анкету',invite_later:'Баннер: позже',map_donate:'Донат на карте',
 donation_checkout:'Перейти к оплате',place_save:'Сохранить место',wish_create:'Создать желание'
};
