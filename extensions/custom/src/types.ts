import type { DirectusUser, DirectusFile } from "@directus/sdk";

export interface Schema {
  comments: Comment[];
  languages: Language[];
  listening_attempts: ListeningAttempt[];
  listening_clips: ListeningClip[];
  listening_groups: ListeningGroup[];
  listening_skills: ListeningSkill[];
  listening_lessons: ListeningLesson[];
  listening_progress: ListeningProgress[];
  listening_tests: ListeningTest[];
  listening_tests_files: ListeningTestFile[];
  master_wallet: MasterWallet;
  plan_prices: PlanPrice[];
  plans: Plan[];
  promotions: Promotion[];
  purchase_histories: PurchaseHistory[];
  source_videos: SourceVideo[];
  directus_users: CustomDirectusUser;
}

export interface Comment {
  id: string;
  date_created: "datetime" | null;
  date_updated: "datetime" | null;
  user_created: string | null;
  user_updated: string | null;
  lesson_id: string | ListeningLesson | null;
  parent_id: string | Comment | null;
  content: string | null;
  upvotes: number | null;
  downvotes: number | null;
}

export interface Language {
  code: string;
  name: string | null;
}

export interface ListeningAttempt {
  id: string;
  user_id: string | DirectusUser<Schema> | null;
  clip_id: string | ListeningClip | null;
  answer: string | null;
  is_correct: boolean | null;
  lesson_id: string | ListeningLesson | null;
  step: "type" | "voice" | "challenge" | "more" | null;
  mode: string | null;
  attempt_number: number | null;
  listen_count: number | null;
  date_created: "datetime" | null;
}

export interface ListeningClip {
  id: string;
  status: "published" | "draft" | "archived" | null;
  date_created: "datetime" | null;
  date_updated: "datetime" | null;
  source_video_id: string | SourceVideo | null;
  start_time: number | null;
  end_time: number | null;
  transcript: string | null;
  sort: number | null;
  lesson_id: string | ListeningLesson | null;
  step: "type" | "voice" | "challenge" | null;
  challenge_mode: "sentence" | "speed" | null;
  answer: string | null;
}

export interface ListeningGroup {
  id: string;
  status: "published" | "draft" | "archived";
  sort: number | null;
  name: string;
  slug: string;
  answer_mode: "one_answer" | "per_clip";
  is_premium: boolean;
}

export interface ListeningSkill {
  id: string;
  status: "published" | "draft" | "archived";
  sort: number | null;
  group_id: string | ListeningGroup;
  category: string | null;
  name: string;
  slug: string;
  is_premium: boolean;
}

export interface ListeningLesson {
  id: string;
  status: "published" | "draft" | "archived";
  sort: number | null;
  skill_id: string | ListeningSkill;
  short_id: string;
  slug: string | null;
  text: string;
  difficulty: "easy" | "medium" | "hard";
  is_premium: boolean;
  learners_count: number;
  date_created: "datetime" | null;
  date_updated: "datetime" | null;
}

export interface ListeningProgress {
  id: string;
  user_id: string | DirectusUser<Schema>;
  lesson_id: string | ListeningLesson;
  status: "in_progress" | "completed";
  step_results: unknown | null;
  score: number | null;
  completed_at: "datetime" | null;
}

export interface ListeningTest {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  accent: string;
  duration_seconds: number | null;
  question_count: number;
  is_free: boolean;
  instruction_text: string | null;
  transcript: string | null;
  prosody_script: string | null;
  date_created: "datetime" | null;
  date_updated: "datetime" | null;
  status: "draft" | "published" | "archived" | null;
  metadata: unknown | null;
  questions_public_json: unknown | null;
  questions_answer_json: unknown | null;
  thumbnail: string | DirectusFile<Schema> | null;
  map_image: string | DirectusFile<Schema> | null;
  type: "map_labelling" | "plan_labelling" | null;
  topic: string | null;
  tests_taken: number | null;
  level: "basic" | "medium" | "hard" | null;
  audio_file: string[] | ListeningTestFile[];
}

export interface ListeningTestFile {
  id: number;
  listening_tests_id: string | ListeningTest | null;
  directus_files_id: string | DirectusFile<Schema> | null;
}

export interface MasterWallet {
  id: string;
  date_created: "datetime" | null;
  date_updated: "datetime" | null;
  bank_account: string | null;
  bank_account_name: string | null;
  bank_name: string | null;
  bank_id: string | null;
  auth_key: string | null;
}

export interface PlanPrice {
  id: string;
  status: "published" | "draft" | "archived";
  sort: number | null;
  user_created: string | DirectusUser<Schema> | null;
  date_created: "datetime" | null;
  user_updated: string | DirectusUser<Schema> | null;
  date_updated: "datetime" | null;
  plan_id: string | Plan | null;
  duration_month: number | null;
  monthly_price: number | null;
  currency: "vnd" | "usd" | null;
  total_price: number | null;
}

export interface Plan {
  id: string;
  status: "published" | "draft" | "archived";
  sort: number | null;
  user_created: string | DirectusUser<Schema> | null;
  date_created: "datetime" | null;
  user_updated: string | DirectusUser<Schema> | null;
  date_updated: "datetime" | null;
  name: string | null;
  description: string | null;
  code: string | null;
}

export interface Promotion {
  id: string;
  code: string | null;
  title: string | null;
  type: string | null;
  value: number | null;
  status: string | null;
  valid_from: "datetime" | null;
  valid_until: "datetime" | null;
  date_created: "datetime" | null;
}

export interface PurchaseHistory {
  id: string;
  status: "published" | "draft" | "archived";
  sort: number | null;
  user_created: string | DirectusUser<Schema> | null;
  date_created: "datetime" | null;
  user_updated: string | DirectusUser<Schema> | null;
  date_updated: "datetime" | null;
  payment_method: "bank_transfer" | "visa_creadit_cards" | null;
  date_transfer: "datetime" | null;
  user: string | DirectusUser<Schema> | null;
  currency: "vnd" | "usd" | null;
  amount: number | null;
  transfer_code: string | null;
  plan_id: string | null;
  billing_cycle: number | null;
  type: string | null;
  promotion_id: string | null;
  price_original: number | null;
  price_subtotal: number | null;
  vat_rate: number | null;
  vat_amount: number | null;
  auto_renew: boolean | null;
  expire_time: "datetime" | null;
}

export interface SourceVideo {
  id: string;
  status: "published" | "draft" | "archived" | null;
  date_created: "datetime" | null;
  date_updated: "datetime" | null;
  youtube_video_id: string | null;
  title: string | null;
  channel_name: string | null;
  thumbnail_url: string | null;
}

export interface CustomDirectusUser {
  is_premium: boolean | null;
  premium_until: "datetime" | null;
  subscription_type: "pro" | null;
}

// GeoJSON Types

export interface GeoJSONPoint {
  type: "Point";
  coordinates: [number, number];
}

export interface GeoJSONLineString {
  type: "LineString";
  coordinates: Array<[number, number]>;
}

export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: Array<Array<[number, number]>>;
}

export interface GeoJSONMultiPoint {
  type: "MultiPoint";
  coordinates: Array<[number, number]>;
}

export interface GeoJSONMultiLineString {
  type: "MultiLineString";
  coordinates: Array<Array<[number, number]>>;
}

export interface GeoJSONMultiPolygon {
  type: "MultiPolygon";
  coordinates: Array<Array<Array<[number, number]>>>;
}

export interface GeoJSONGeometryCollection {
  type: "GeometryCollection";
  geometries: Array<
    | GeoJSONPoint
    | GeoJSONLineString
    | GeoJSONPolygon
    | GeoJSONMultiPoint
    | GeoJSONMultiLineString
    | GeoJSONMultiPolygon
  >;
}
