--
-- PostgreSQL database dump
--

-- Dumped from database version 16.2
-- Dumped by pg_dump version 16.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: directus_collections; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.directus_collections (collection, icon, note, display_template, hidden, singleton, translations, archive_field, archive_app_filter, archive_value, unarchive_value, sort_field, accountability, color, item_duplication_fields, sort, "group", collapse, preview_url, versioning) FROM stdin;
listening_targets_listening_types	import_export	\N	\N	t	f	\N	\N	t	\N	\N	\N	all	\N	\N	1	listening_targets	open	\N	f
listening_targets_translations	translate	\N	\N	t	f	\N	\N	t	\N	\N	\N	all	\N	\N	2	listening_targets	open	\N	f
comments	chat	User comments on listening targets	{{content}}	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	1	\N	open	\N	f
languages	translate	System Languages	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	2	\N	open	\N	f
listening_attempts	box	Collection for listening_attempts	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	3	\N	open	\N	f
listening_clips	box	Collection for listening_clips	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	4	\N	open	\N	f
listening_quota_clips	\N	\N	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	5	\N	open	\N	f
listening_target_learners	\N	\N	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	6	\N	open	\N	f
listening_targets	box	Collection for listening_targets	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	7	\N	open	\N	f
listening_tests	\N	\N	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	8	\N	open	\N	f
listening_tests_files	import_export	\N	\N	t	f	\N	\N	t	\N	\N	\N	all	\N	\N	9	\N	open	\N	f
listening_types	\N	\N	\N	f	f	\N	status	t	archived	draft	sort	all	\N	\N	10	\N	open	\N	f
master_wallet	\N	\N	\N	f	t	\N	\N	t	\N	\N	\N	all	\N	\N	11	\N	open	\N	f
plan_prices	\N	\N	\N	f	f	\N	status	t	archived	draft	sort	all	\N	\N	12	\N	open	\N	f
plans	\N	\N	\N	f	f	\N	status	t	archived	draft	sort	all	\N	\N	13	\N	open	\N	f
promotions	\N	\N	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	14	\N	open	\N	f
purchase_histories	\N	\N	\N	f	f	\N	status	t	archived	draft	sort	all	\N	\N	15	\N	open	\N	f
source_videos	box	Collection for source_videos	\N	f	f	\N	\N	t	\N	\N	\N	all	\N	\N	16	\N	open	\N	f
phrase_requests	lightbulb	Cụm từ người dùng muốn có bài luyện (ẩn danh)	\N	f	f	\N	status	t	hidden	new	\N	all	\N	\N	\N	\N	open	\N	f
\.


--
-- Data for Name: directus_fields; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.directus_fields (id, collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note, conditions, required, "group", validation, validation_message) FROM stdin;
21	listening_tests	question_count	\N	\N	\N	\N	\N	f	f	15	full	\N	\N	\N	f	\N	\N	\N
48	listening_tests_files	id	\N	\N	\N	\N	\N	f	t	1	full	\N	\N	\N	f	\N	\N	\N
49	listening_tests_files	listening_tests_id	\N	\N	\N	\N	\N	f	t	2	full	\N	\N	\N	f	\N	\N	\N
50	listening_tests_files	directus_files_id	\N	\N	\N	\N	\N	f	t	3	full	\N	\N	\N	f	\N	\N	\N
26	listening_tests	instruction_text	\N	\N	\N	\N	\N	f	f	16	full	\N	\N	\N	f	\N	\N	\N
27	listening_tests	transcript	\N	\N	\N	\N	\N	f	f	17	full	\N	\N	\N	f	\N	\N	\N
28	listening_tests	prosody_script	\N	\N	\N	\N	\N	f	f	18	full	\N	\N	\N	f	\N	\N	\N
43	listening_tests	metadata	cast-json	input-code	\N	\N	\N	f	f	19	full	\N	\N	\N	f	\N	\N	\N
197	comments	date_created	date-created	datetime	\N	\N	\N	t	f	2	full	\N	\N	\N	f	\N	\N	\N
198	comments	date_updated	date-updated	datetime	\N	\N	\N	t	f	3	full	\N	\N	\N	f	\N	\N	\N
199	comments	user_created	user-created	select-dropdown-m2o	\N	\N	\N	t	f	4	full	\N	\N	\N	f	\N	\N	\N
200	comments	user_updated	user-updated	select-dropdown-m2o	\N	\N	\N	t	f	5	full	\N	\N	\N	f	\N	\N	\N
201	comments	target_id	\N	select-dropdown-m2o	\N	\N	\N	f	f	6	full	\N	\N	\N	f	\N	\N	\N
202	comments	parent_id	\N	select-dropdown-m2o	\N	\N	\N	f	f	7	full	\N	\N	\N	f	\N	\N	\N
203	comments	content	\N	input-multiline	\N	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
204	comments	upvotes	\N	input	\N	\N	\N	f	f	9	full	\N	\N	\N	f	\N	\N	\N
205	comments	downvotes	\N	input	\N	\N	\N	f	f	10	full	\N	\N	\N	f	\N	\N	\N
196	comments	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
206	listening_targets	learners_count	\N	input	\N	\N	\N	f	f	11	full	\N	\N	\N	f	\N	\N	\N
219	listening_clips	target_id	m2o	select-dropdown-m2o	\N	\N	\N	f	f	10	full	\N	\N	\N	f	\N	\N	\N
220	listening_targets	listening_clips	o2m	list-o2m	\N	\N	\N	f	f	13	full	\N	\N	\N	f	\N	\N	\N
223	listening_types	slug	\N	input	\N	\N	\N	f	f	9	full	\N	\N	\N	f	\N	\N	\N
224	listening_targets	slug	\N	input	\N	\N	\N	f	f	16	full	\N	\N	\N	f	\N	\N	\N
225	listening_targets	name	\N	input	\N	\N	\N	f	f	17	full	\N	\N	\N	f	\N	\N	\N
226	listening_targets	short_id	\N	input	\N	\N	\N	f	f	18	full	\N	\N	\N	f	\N	\N	\N
227	listening_targets	is_free	cast-boolean	boolean	\N	\N	\N	f	f	19	full	\N	\N	\N	f	\N	\N	\N
228	listening_types	parent_id	m2o	select-dropdown-m2o	\N	\N	\N	f	f	10	full	\N	\N	\N	f	\N	\N	\N
46	listening_tests	thumbnail	file	file-image	{"folder":"a9fabeaa-6e7b-490b-8c7d-10b0127d4c80"}	\N	\N	f	f	20	full	\N	\N	\N	f	\N	\N	\N
52	listening_tests	type	\N	select-dropdown	{"choices":[{"text":"Map labeling","value":"map_labelling"},{"text":"Plan lebelling","value":"plan_labelling"}]}	\N	\N	f	f	21	full	\N	\N	\N	f	\N	\N	\N
12	listening_tests	id	uuid	\N	\N	\N	\N	f	t	1	full	\N	\N	\N	f	\N	\N	\N
29	listening_tests	date_created	\N	\N	\N	\N	\N	f	t	2	half	\N	\N	\N	f	\N	\N	\N
30	listening_tests	date_updated	\N	\N	\N	\N	\N	f	t	3	half	\N	\N	\N	f	\N	\N	\N
42	listening_tests	status	\N	select-dropdown	{"choices":[{"text":"Draft","value":"draft"},{"text":"Published","value":"published"},{"text":"Archived","value":"archived"}]}	\N	\N	f	f	4	full	\N	\N	\N	f	\N	\N	\N
47	listening_tests	audio_file	files	files	{"folder":"f8991372-16b4-4b33-8f5b-a6af78f1861a"}	\N	\N	f	f	5	full	\N	\N	[{"name":"audio free","rule":{"_and":[{"is_free":{"_eq":true}}]},"options":{"folder":"7b914226-4789-48cf-a2f5-8f85b73f2f64"}},{"name":"audio paid","rule":{"_and":[{"is_free":{"_eq":false}}]},"options":{"folder":"f8991372-16b4-4b33-8f5b-a6af78f1861a"}}]	f	\N	\N	\N
51	listening_tests	map_image	file	file-image	\N	\N	\N	f	f	6	full	\N	\N	[{"name":"free","rule":{"_and":[{"is_free":{"_eq":true}}]},"options":{"folder":"4a56719f-2169-430c-b5fe-aa5162c9ccde"}},{"name":"paid","rule":{"_and":[{"is_free":{"_eq":false}}]},"options":{"folder":"f00808cc-f2f2-4344-ab8f-3ff37cc8dfb2"}}]	f	\N	\N	\N
22	listening_tests	is_free	cast-boolean	\N	\N	\N	\N	f	f	7	full	\N	\N	\N	f	\N	\N	\N
14	listening_tests	title	\N	\N	\N	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
15	listening_tests	slug	\N	\N	\N	\N	\N	f	f	9	full	\N	\N	\N	f	\N	\N	\N
16	listening_tests	description	\N	\N	\N	\N	\N	f	f	10	full	\N	\N	\N	f	\N	\N	\N
44	listening_tests	questions_public_json	cast-json	input-code	\N	\N	\N	f	f	11	full	\N	\N	\N	f	\N	\N	\N
45	listening_tests	questions_answer_json	cast-json	input-code	\N	\N	\N	f	f	12	full	\N	\N	\N	f	\N	\N	\N
19	listening_tests	accent	\N	\N	\N	\N	\N	f	f	13	full	\N	\N	\N	f	\N	\N	\N
20	listening_tests	duration_seconds	\N	\N	\N	\N	\N	f	f	14	full	\N	\N	\N	f	\N	\N	\N
207	listening_types	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
208	listening_types	status	\N	select-dropdown	{"choices":[{"text":"$t:published","value":"published","color":"var(--theme--primary)"},{"text":"$t:draft","value":"draft","color":"var(--theme--foreground)"},{"text":"$t:archived","value":"archived","color":"var(--theme--warning)"}]}	labels	{"showAsDot":true,"choices":[{"text":"$t:published","value":"published","color":"var(--theme--primary)","foreground":"var(--theme--primary)","background":"var(--theme--primary-background)"},{"text":"$t:draft","value":"draft","color":"var(--theme--foreground)","foreground":"var(--theme--foreground)","background":"var(--theme--background-normal)"},{"text":"$t:archived","value":"archived","color":"var(--theme--warning)","foreground":"var(--theme--warning)","background":"var(--theme--warning-background)"}]}	f	f	2	full	\N	\N	\N	f	\N	\N	\N
209	listening_types	sort	\N	input	\N	\N	\N	f	t	3	full	\N	\N	\N	f	\N	\N	\N
210	listening_types	user_created	user-created	select-dropdown-m2o	{"template":"{{avatar}} {{first_name}} {{last_name}}"}	user	\N	t	t	4	half	\N	\N	\N	f	\N	\N	\N
211	listening_types	date_created	date-created	datetime	\N	datetime	{"relative":true}	t	t	5	half	\N	\N	\N	f	\N	\N	\N
212	listening_types	user_updated	user-updated	select-dropdown-m2o	{"template":"{{avatar}} {{first_name}} {{last_name}}"}	user	\N	t	t	6	half	\N	\N	\N	f	\N	\N	\N
213	listening_types	date_updated	date-updated	datetime	\N	datetime	{"relative":true}	t	t	7	half	\N	\N	\N	f	\N	\N	\N
221	listening_targets	difficulty	\N	select-dropdown	{"choices":[{"text":"Easy","value":"easy"},{"text":"Medium","value":"medium"},{"text":"Hard","value":"hard"}]}	\N	\N	f	f	14	full	\N	\N	\N	f	\N	\N	\N
214	listening_types	name	\N	input	\N	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
215	listening_targets	types	m2m	list-m2m	\N	\N	\N	f	f	12	full	\N	\N	\N	f	\N	\N	\N
216	listening_targets_listening_types	id	\N	\N	\N	\N	\N	f	t	1	full	\N	\N	\N	f	\N	\N	\N
217	listening_targets_listening_types	listening_targets_id	\N	\N	\N	\N	\N	f	t	2	full	\N	\N	\N	f	\N	\N	\N
218	listening_targets_listening_types	listening_types_id	\N	\N	\N	\N	\N	f	t	3	full	\N	\N	\N	f	\N	\N	\N
91	master_wallet	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
92	master_wallet	date_created	date-created	datetime	\N	datetime	{"relative":true}	t	t	2	half	\N	\N	\N	f	\N	\N	\N
93	master_wallet	date_updated	date-updated	datetime	\N	datetime	{"relative":true}	t	t	3	half	\N	\N	\N	f	\N	\N	\N
94	master_wallet	bank_account	\N	input	\N	\N	\N	f	f	4	full	\N	\N	\N	f	\N	\N	\N
95	master_wallet	bank_account_name	\N	input	\N	\N	\N	f	f	5	full	\N	\N	\N	f	\N	\N	\N
96	master_wallet	bank_name	\N	input	\N	\N	\N	f	f	6	full	\N	\N	\N	f	\N	\N	\N
97	master_wallet	bank_id	\N	input	\N	\N	\N	f	f	7	full	\N	\N	\N	f	\N	\N	\N
98	master_wallet	auth_key	\N	input	\N	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
100	directus_users	is_premium	cast-boolean	boolean	\N	\N	\N	f	f	1	full	\N	\N	\N	f	\N	\N	\N
101	directus_users	premium_until	\N	datetime	\N	\N	\N	f	f	2	full	\N	\N	\N	f	\N	\N	\N
102	directus_users	subscription_type	\N	select-dropdown	{"choices":[{"text":"Pro","value":"pro"}]}	\N	\N	f	f	3	full	\N	\N	\N	f	\N	\N	\N
112	purchase_histories	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
113	purchase_histories	status	\N	select-dropdown	{"choices":[{"text":"$t:published","value":"published","color":"var(--theme--primary)"},{"text":"$t:draft","value":"draft","color":"var(--theme--foreground)"},{"text":"$t:archived","value":"archived","color":"var(--theme--warning)"}]}	labels	{"showAsDot":true,"choices":[{"text":"$t:published","value":"published","color":"var(--theme--primary)","foreground":"var(--theme--primary)","background":"var(--theme--primary-background)"},{"text":"$t:draft","value":"draft","color":"var(--theme--foreground)","foreground":"var(--theme--foreground)","background":"var(--theme--background-normal)"},{"text":"$t:archived","value":"archived","color":"var(--theme--warning)","foreground":"var(--theme--warning)","background":"var(--theme--warning-background)"}]}	f	f	2	full	\N	\N	\N	f	\N	\N	\N
114	purchase_histories	sort	\N	input	\N	\N	\N	f	t	3	full	\N	\N	\N	f	\N	\N	\N
115	purchase_histories	user_created	user-created	select-dropdown-m2o	{"template":"{{avatar}} {{first_name}} {{last_name}}"}	user	\N	t	t	4	half	\N	\N	\N	f	\N	\N	\N
116	purchase_histories	date_created	date-created	datetime	\N	datetime	{"relative":true}	t	t	5	half	\N	\N	\N	f	\N	\N	\N
117	purchase_histories	user_updated	user-updated	select-dropdown-m2o	{"template":"{{avatar}} {{first_name}} {{last_name}}"}	user	\N	t	t	6	half	\N	\N	\N	f	\N	\N	\N
118	purchase_histories	date_updated	date-updated	datetime	\N	datetime	{"relative":true}	t	t	7	half	\N	\N	\N	f	\N	\N	\N
119	purchase_histories	payment_method	\N	select-dropdown	{"choices":[{"text":"BANK TRANSFER","value":"bank_transfer"},{"text":"VISA/CREADIT CARDS","value":"visa_creadit_cards"}]}	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
120	purchase_histories	date_transfer	\N	datetime	\N	\N	\N	f	f	9	full	\N	\N	\N	f	\N	\N	\N
121	purchase_histories	user	m2o	select-dropdown-m2o	\N	\N	\N	f	f	10	full	\N	\N	\N	f	\N	\N	\N
122	purchase_histories	currency	\N	select-radio	{"choices":[{"text":"VND","value":"vnd"},{"text":"USD","value":"usd"}]}	\N	\N	f	f	11	full	\N	\N	\N	f	\N	\N	\N
123	purchase_histories	amount	\N	input	\N	\N	\N	f	f	12	full	\N	\N	\N	f	\N	\N	\N
124	purchase_histories	transfer_code	\N	input	\N	\N	\N	f	f	13	full	\N	\N	\N	f	\N	\N	\N
125	plans	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
126	plans	status	\N	select-dropdown	{"choices":[{"text":"$t:published","value":"published","color":"var(--theme--primary)"},{"text":"$t:draft","value":"draft","color":"var(--theme--foreground)"},{"text":"$t:archived","value":"archived","color":"var(--theme--warning)"}]}	labels	{"showAsDot":true,"choices":[{"text":"$t:published","value":"published","color":"var(--theme--primary)","foreground":"var(--theme--primary)","background":"var(--theme--primary-background)"},{"text":"$t:draft","value":"draft","color":"var(--theme--foreground)","foreground":"var(--theme--foreground)","background":"var(--theme--background-normal)"},{"text":"$t:archived","value":"archived","color":"var(--theme--warning)","foreground":"var(--theme--warning)","background":"var(--theme--warning-background)"}]}	f	f	2	full	\N	\N	\N	f	\N	\N	\N
127	plans	sort	\N	input	\N	\N	\N	f	t	3	full	\N	\N	\N	f	\N	\N	\N
128	plans	user_created	user-created	select-dropdown-m2o	{"template":"{{avatar}} {{first_name}} {{last_name}}"}	user	\N	t	t	4	half	\N	\N	\N	f	\N	\N	\N
88	listening_tests	topic	\N	input	\N	\N	\N	f	f	22	full	\N	\N	\N	f	\N	\N	\N
89	listening_tests	tests_taken	\N	input	\N	\N	\N	f	f	23	full	\N	\N	\N	f	\N	\N	\N
90	listening_tests	level	\N	select-dropdown	{"choices":[{"text":"Basic","value":"basic"},{"text":"Medium","value":"medium"},{"text":"Hard","value":"hard"}]}	\N	\N	f	f	24	full	\N	\N	\N	f	\N	\N	\N
129	plans	date_created	date-created	datetime	\N	datetime	{"relative":true}	t	t	5	half	\N	\N	\N	f	\N	\N	\N
130	plans	user_updated	user-updated	select-dropdown-m2o	{"template":"{{avatar}} {{first_name}} {{last_name}}"}	user	\N	t	t	6	half	\N	\N	\N	f	\N	\N	\N
131	plans	date_updated	date-updated	datetime	\N	datetime	{"relative":true}	t	t	7	half	\N	\N	\N	f	\N	\N	\N
132	plans	name	\N	input	\N	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
133	plans	description	\N	input	\N	\N	\N	f	f	9	full	\N	\N	\N	f	\N	\N	\N
134	plans	code	\N	input	\N	\N	\N	f	f	10	full	\N	\N	\N	f	\N	\N	\N
135	plan_prices	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
136	plan_prices	status	\N	select-dropdown	{"choices":[{"text":"$t:published","value":"published","color":"var(--theme--primary)"},{"text":"$t:draft","value":"draft","color":"var(--theme--foreground)"},{"text":"$t:archived","value":"archived","color":"var(--theme--warning)"}]}	labels	{"showAsDot":true,"choices":[{"text":"$t:published","value":"published","color":"var(--theme--primary)","foreground":"var(--theme--primary)","background":"var(--theme--primary-background)"},{"text":"$t:draft","value":"draft","color":"var(--theme--foreground)","foreground":"var(--theme--foreground)","background":"var(--theme--background-normal)"},{"text":"$t:archived","value":"archived","color":"var(--theme--warning)","foreground":"var(--theme--warning)","background":"var(--theme--warning-background)"}]}	f	f	2	full	\N	\N	\N	f	\N	\N	\N
137	plan_prices	sort	\N	input	\N	\N	\N	f	t	3	full	\N	\N	\N	f	\N	\N	\N
138	plan_prices	user_created	user-created	select-dropdown-m2o	{"template":"{{avatar}} {{first_name}} {{last_name}}"}	user	\N	t	t	4	half	\N	\N	\N	f	\N	\N	\N
139	plan_prices	date_created	date-created	datetime	\N	datetime	{"relative":true}	t	t	5	half	\N	\N	\N	f	\N	\N	\N
140	plan_prices	user_updated	user-updated	select-dropdown-m2o	{"template":"{{avatar}} {{first_name}} {{last_name}}"}	user	\N	t	t	6	half	\N	\N	\N	f	\N	\N	\N
141	plan_prices	date_updated	date-updated	datetime	\N	datetime	{"relative":true}	t	t	7	half	\N	\N	\N	f	\N	\N	\N
142	plan_prices	plan_id	m2o	select-dropdown-m2o	\N	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
143	plan_prices	duration_month	\N	input	\N	\N	\N	f	f	9	full	\N	\N	\N	f	\N	\N	\N
158	source_videos	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
166	listening_clips	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
146	plan_prices	monthly_price	\N	input	\N	\N	\N	f	f	12	full	\N	\N	\N	f	\N	\N	\N
147	plan_prices	currency	\N	select-radio	{"choices":[{"text":"VND","value":"vnd"},{"text":"USD","value":"usd"}]}	\N	\N	f	f	13	full	\N	\N	\N	f	\N	\N	\N
148	plan_prices	total_price	\N	input	\N	\N	\N	f	f	14	full	\N	\N	\N	f	\N	\N	\N
150	listening_targets	status	\N	select-dropdown	{"choices":[{"text":"Published","value":"published"},{"text":"Draft","value":"draft"},{"text":"Archived","value":"archived"}]}	\N	\N	f	f	2	full	\N	\N	\N	f	\N	\N	\N
151	listening_targets	date_created	date-created	datetime	\N	\N	\N	t	t	3	full	\N	\N	\N	f	\N	\N	\N
152	listening_targets	date_updated	date-updated	datetime	\N	\N	\N	t	t	4	full	\N	\N	\N	f	\N	\N	\N
153	listening_targets	text	\N	input	\N	\N	\N	f	f	5	full	\N	\N	\N	f	\N	\N	\N
175	listening_attempts	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
188	listening_targets_translations	explanation	\N	input-rich-text-md	\N	\N	\N	f	f	4	full	\N	\N	\N	f	\N	\N	\N
159	source_videos	status	\N	select-dropdown	{"choices":[{"text":"Published","value":"published"},{"text":"Draft","value":"draft"},{"text":"Archived","value":"archived"}]}	\N	\N	f	f	2	full	\N	\N	\N	f	\N	\N	\N
160	source_videos	date_created	date-created	datetime	\N	\N	\N	t	t	3	full	\N	\N	\N	f	\N	\N	\N
161	source_videos	date_updated	date-updated	datetime	\N	\N	\N	t	t	4	full	\N	\N	\N	f	\N	\N	\N
162	source_videos	youtube_video_id	\N	input	\N	\N	\N	f	f	5	full	\N	\N	\N	f	\N	\N	\N
163	source_videos	title	\N	input	\N	\N	\N	f	f	6	full	\N	\N	\N	f	\N	\N	\N
164	source_videos	channel_name	\N	input	\N	\N	\N	f	f	7	full	\N	\N	\N	f	\N	\N	\N
165	source_videos	thumbnail_url	\N	input	\N	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
167	listening_clips	status	\N	select-dropdown	{"choices":[{"text":"Published","value":"published"},{"text":"Draft","value":"draft"},{"text":"Archived","value":"archived"}]}	\N	\N	f	f	2	full	\N	\N	\N	f	\N	\N	\N
168	listening_clips	date_created	date-created	datetime	\N	\N	\N	t	t	3	full	\N	\N	\N	f	\N	\N	\N
169	listening_clips	date_updated	date-updated	datetime	\N	\N	\N	t	t	4	full	\N	\N	\N	f	\N	\N	\N
170	listening_clips	source_video_id	\N	select-dropdown-m2o	\N	\N	\N	f	f	5	full	\N	\N	\N	f	\N	\N	\N
172	listening_clips	start_time	\N	input	\N	\N	\N	f	f	7	full	\N	\N	\N	f	\N	\N	\N
173	listening_clips	end_time	\N	input	\N	\N	\N	f	f	8	full	\N	\N	\N	f	\N	\N	\N
174	listening_clips	transcript	\N	input-multiline	\N	\N	\N	f	f	9	full	\N	\N	\N	f	\N	\N	\N
176	listening_attempts	user_id	\N	select-dropdown-m2o	\N	\N	\N	f	f	2	full	\N	\N	\N	f	\N	\N	\N
177	listening_attempts	clip_id	\N	select-dropdown-m2o	\N	\N	\N	f	f	3	full	\N	\N	\N	f	\N	\N	\N
178	listening_attempts	answer	\N	input	\N	\N	\N	f	f	4	full	\N	\N	\N	f	\N	\N	\N
179	listening_attempts	is_correct	\N	boolean	\N	\N	\N	f	f	5	full	\N	\N	\N	f	\N	\N	\N
180	listening_attempts	attempt_number	\N	input	\N	\N	\N	f	f	6	full	\N	\N	\N	f	\N	\N	\N
181	listening_attempts	listen_count	\N	input	\N	\N	\N	f	f	7	full	\N	\N	\N	f	\N	\N	\N
182	listening_attempts	date_created	date-created	datetime	\N	\N	\N	t	t	8	full	\N	\N	\N	f	\N	\N	\N
149	listening_targets	id	uuid	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
183	languages	code	\N	input	\N	\N	\N	f	f	1	full	\N	\N	\N	f	\N	\N	\N
184	languages	name	\N	input	\N	\N	\N	f	f	2	full	\N	\N	\N	f	\N	\N	\N
185	listening_targets_translations	id	\N	input	\N	\N	\N	t	t	1	full	\N	\N	\N	f	\N	\N	\N
186	listening_targets_translations	listening_targets_id	\N	\N	\N	\N	\N	f	t	2	full	\N	\N	\N	f	\N	\N	\N
187	listening_targets_translations	languages_code	\N	\N	\N	\N	\N	f	t	3	full	\N	\N	\N	f	\N	\N	\N
190	listening_targets	translations	translations	translations	\N	\N	\N	f	f	10	full	\N	\N	\N	f	\N	\N	\N
189	listening_targets_translations	tips	\N	input-multiline	\N	\N	\N	f	f	5	full	\N	\N	\N	f	\N	\N	\N
\.


--
-- Data for Name: directus_permissions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.directus_permissions (id, collection, action, permissions, validation, presets, fields, policy) FROM stdin;
23	directus_files	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
53	directus_users	read	\N	\N	\N	is_premium,premium_until,subscription_type	8881ead6-d324-4a2a-82b1-3867c1314422
26	directus_collections	read	{}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
27	directus_fields	read	{}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
28	directus_relations	read	{}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
29	directus_translations	read	{}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
30	directus_activity	read	{"user":{"_eq":"$CURRENT_USER"}}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
31	directus_comments	read	{"user_created":{"_eq":"$CURRENT_USER"}}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
32	directus_comments	create	{}	{"comment":{"_nnull":true}}	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
33	directus_comments	update	{"user_created":{"_eq":"$CURRENT_USER"}}	\N	\N	comment	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
34	directus_comments	delete	{"user_created":{"_eq":"$CURRENT_USER"}}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
35	directus_presets	read	{"_or":[{"user":{"_eq":"$CURRENT_USER"}},{"_and":[{"user":{"_null":true}},{"role":{"_eq":"$CURRENT_ROLE"}}]},{"_and":[{"user":{"_null":true}},{"role":{"_null":true}}]}]}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
36	directus_presets	create	{}	{"user":{"_eq":"$CURRENT_USER"}}	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
37	directus_presets	update	{"user":{"_eq":"$CURRENT_USER"}}	{"user":{"_eq":"$CURRENT_USER"}}	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
38	directus_presets	delete	{"user":{"_eq":"$CURRENT_USER"}}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
39	directus_roles	read	{"id":{"_in":"$CURRENT_ROLES"}}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
40	directus_settings	read	{}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
41	directus_translations	read	{}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
42	directus_notifications	read	{"recipient":{"_eq":"$CURRENT_USER"}}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
43	directus_notifications	update	{"recipient":{"_eq":"$CURRENT_USER"}}	\N	\N	status	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
44	directus_shares	read	{"user_created":{"_eq":"$CURRENT_USER"}}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
77	source_videos	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
52	purchase_histories	read	{"_and":[{"user":{"_eq":"$CURRENT_USER"}}]}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
45	directus_users	read	{"id":{"_eq":"$CURRENT_USER"}}	\N	\N	id,first_name,last_name,last_page,email,password,location,title,description,tags,preferences_divider,avatar,language,appearance,theme_light,theme_dark,tfa_secret,status,role,premium_until,is_premium,subscription_type	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
54	purchase_histories	read	{"_and":[{"user":{"_eq":"$CURRENT_USER"}}]}	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
55	listening_tests_files	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
46	listening_tests	read	{"_and":[{"is_free":{"_eq":true}}]}	\N	\N	id,date_created,date_updated,status,title,slug,description,questions_public_json,accent,audio_file,map_image,duration_seconds,question_count,is_free,instruction_text,prosody_script,metadata,thumbnail,type,topic,tests_taken,level	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
56	listening_tests_files	read	{"_and":[{"directus_files_id":{"folder":{"_neq":"f8991372-16b4-4b33-8f5b-a6af78f1861a"}}}]}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
82	listening_types	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
1	listening_tests	read	\N	\N	\N	id,status,title,slug,description,accent,map_image,duration_seconds,question_count,is_free,instruction_text,prosody_script,thumbnail,type,topic,tests_taken,level,date_created,metadata	abf8a154-5b1c-4a46-ac9c-7300570f4f17
57	comments	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
59	listening_clips	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
60	listening_targets	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
61	source_videos	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
62	listening_targets_translations	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
63	languages	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
64	listening_types	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
65	listening_targets_listening_types	read	\N	\N	\N	*	abf8a154-5b1c-4a46-ac9c-7300570f4f17
66	source_videos	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
67	plan_prices	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
68	plans	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
69	listening_types	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
70	listening_targets_translations	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
71	listening_targets_listening_types	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
72	listening_targets	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
73	listening_clips	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
75	languages	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
76	comments	read	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
83	listening_targets_translations	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
84	listening_targets_listening_types	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
85	listening_targets	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
88	listening_clips	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
90	languages	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
91	comments	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
47	listening_tests	read	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
97	comments	create	\N	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
94	comments	create	\N	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
95	comments	update	{"_and":[{"user_created":{"_eq":"$CURRENT_USER"}}]}	\N	\N	*	8881ead6-d324-4a2a-82b1-3867c1314422
96	comments	delete	{"_and":[{"user_created":{"_eq":"$CURRENT_USER"}}]}	\N	\N	\N	8881ead6-d324-4a2a-82b1-3867c1314422
98	comments	update	{"_and":[{"user_created":{"_eq":"$CURRENT_USER"}}]}	\N	\N	*	bb4a6f63-4b7c-4816-b44f-56aa5dd23033
\.


--
-- Data for Name: directus_relations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.directus_relations (id, many_collection, many_field, one_collection, one_field, one_collection_field, one_allowed_collections, junction_field, sort_field, one_deselect_action) FROM stdin;
1	listening_tests	thumbnail	directus_files	\N	\N	\N	\N	\N	nullify
2	listening_tests_files	directus_files_id	directus_files	\N	\N	\N	listening_tests_id	\N	nullify
3	listening_tests_files	listening_tests_id	listening_tests	audio_file	\N	\N	directus_files_id	\N	nullify
4	listening_tests	map_image	directus_files	\N	\N	\N	\N	\N	nullify
17	purchase_histories	user_created	directus_users	\N	\N	\N	\N	\N	nullify
18	purchase_histories	user_updated	directus_users	\N	\N	\N	\N	\N	nullify
19	purchase_histories	user	directus_users	\N	\N	\N	\N	\N	nullify
20	plans	user_created	directus_users	\N	\N	\N	\N	\N	nullify
21	plans	user_updated	directus_users	\N	\N	\N	\N	\N	nullify
22	plan_prices	user_created	directus_users	\N	\N	\N	\N	\N	nullify
23	plan_prices	user_updated	directus_users	\N	\N	\N	\N	\N	nullify
24	plan_prices	plan_id	plans	\N	\N	\N	\N	\N	nullify
25	listening_clips	source_video_id	source_videos	\N	\N	\N	\N	\N	nullify
27	listening_attempts	user_id	directus_users	\N	\N	\N	\N	\N	nullify
28	listening_attempts	clip_id	listening_clips	\N	\N	\N	\N	\N	nullify
29	listening_targets_translations	listening_targets_id	listening_targets	translations	\N	\N	languages_code	\N	nullify
33	comments	target_id	listening_targets	\N	\N	\N	\N	\N	nullify
34	comments	parent_id	comments	\N	\N	\N	\N	\N	nullify
35	listening_types	user_created	directus_users	\N	\N	\N	\N	\N	nullify
36	listening_types	user_updated	directus_users	\N	\N	\N	\N	\N	nullify
37	listening_targets_listening_types	listening_types_id	listening_types	\N	\N	\N	listening_targets_id	\N	nullify
38	listening_targets_listening_types	listening_targets_id	listening_targets	types	\N	\N	listening_types_id	\N	nullify
39	listening_clips	target_id	listening_targets	listening_clips	\N	\N	\N	\N	nullify
40	listening_types	parent_id	listening_types	\N	\N	\N	\N	\N	nullify
30	listening_targets_translations	languages_code	languages	\N	\N	\N	listening_targets_id	\N	nullify
\.


--
-- Data for Name: listening_types; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.listening_types (id, status, sort, user_created, date_created, user_updated, date_updated, name, slug, parent_id) FROM stdin;
f08efcff-afd4-4ee8-b9a6-d2cc1f4f798b	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-10 11:32:13.268+00	51c14337-58af-49eb-91ca-c139a343c343	2026-09-15 15:09:08.242+00	Connected Speech	connected-speech	\N
b94326ec-dad4-4a7f-9c06-56276825b5fc	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-11 03:12:22.484+00	51c14337-58af-49eb-91ca-c139a343c343	2026-09-15 15:09:16.444+00	Similar Sounds	similar-sounds	\N
e7f6a508-aad8-4c67-8d44-9d65e2ec3c9f	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-15 10:18:43.549+00	51c14337-58af-49eb-91ca-c139a343c343	2026-09-15 15:09:29.394+00	Spelling Names	spelling-names	\N
145010b5-cd65-478c-a3ce-b91334e8a750	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-15 10:18:26.545+00	51c14337-58af-49eb-91ca-c139a343c343	2026-09-15 15:10:38.94+00	Numbers	numbers	\N
1b0823e8-97fa-4dfb-9765-47adbc3e7139	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-10 11:32:31.195+00	51c14337-58af-49eb-91ca-c139a343c343	2026-09-15 15:10:47.069+00	Single Word	single-word	\N
92f37658-a0bc-47b8-b7e5-d4cd9e654a14	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-27 04:19:42.123+00	51c14337-58af-49eb-91ca-c139a343c343	2026-09-27 04:21:45.388+00	Linking Words	linking-words	f08efcff-afd4-4ee8-b9a6-d2cc1f4f798b
706af745-7e6e-476b-a407-7cf3aab959b2	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-27 04:20:56.925+00	51c14337-58af-49eb-91ca-c139a343c343	2026-09-27 04:22:07.768+00	Reduction	reduction	f08efcff-afd4-4ee8-b9a6-d2cc1f4f798b
afdc3833-df57-41be-957a-b577cbe94a72	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-27 04:22:33.52+00	\N	\N	Elision	elision	f08efcff-afd4-4ee8-b9a6-d2cc1f4f798b
5e80a3a5-7d09-4e0e-a88b-8e2f9f341d1d	published	\N	51c14337-58af-49eb-91ca-c139a343c343	2026-09-27 04:23:05.965+00	\N	\N	Assimilation	assimilation	f08efcff-afd4-4ee8-b9a6-d2cc1f4f798b
\.


--
-- Name: directus_fields_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.directus_fields_id_seq', 230, true);


--
-- Name: directus_permissions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.directus_permissions_id_seq', 98, true);


--
-- Name: directus_relations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.directus_relations_id_seq', 40, true);


--
-- PostgreSQL database dump complete
--

