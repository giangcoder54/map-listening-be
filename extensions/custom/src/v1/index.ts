import { defineEndpoint } from '@directus/extensions-sdk';

export default defineEndpoint((router, context) => {
	router.post('/import', async (req, res) => {
		const { ItemsService } = context.services;

		try {
			const payload = req.body;

			if (!payload) {
				return res.status(400).json({
					success: false,
					message: 'Payload is empty',
				});
			}

			if (!payload.title || !payload.slug) {
				return res.status(400).json({
					success: false,
					message: 'Missing required fields: title and slug are required',
				});
			}

			// Helper to validate if a string is a valid UUID
			const isValidUUID = (val: any): boolean => {
				if (typeof val !== 'string') return false;
				const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
				return uuidRegex.test(val);
			};

			const mapImage = isValidUUID(payload.image_file) ? payload.image_file : null;
			const thumbnail = isValidUUID(payload.thumbnail) ? payload.thumbnail : null;

			// Construct the record for listening_tests
			const testData: any = {
				status: payload.status || 'draft',
				title: payload.title,
				slug: payload.slug,
				description: payload.description || null,
				type: payload.type || null,
				level: payload.level || null,
				accent: payload.accent || null,
				duration_seconds: payload.duration_seconds || null,
				question_count: payload.question_count || 0,
				is_free: typeof payload.is_free === 'boolean' ? payload.is_free : true,
				instruction_text: payload.instruction_text || null,
				transcript: payload.transcript || null,
				prosody_script: payload.prosody_script || null,
				questions_public_json: payload.questions_public_json || null,
				questions_answer_json: payload.questions_answer_json || null,
				metadata: payload.metadata || null,
				map_image: mapImage,
				thumbnail: thumbnail,
			};

			// Handle nested O2M/M2M audio files relation
			if (isValidUUID(payload.audio_file)) {
				testData.audio_file = [
					{
						directus_files_id: payload.audio_file,
					},
				];
			}

			// Create the record using ItemsService with administrative accountability to allow public access
			const listeningTestsService = new ItemsService('listening_tests', {
				schema: req.schema,
				accountability: { admin: true, role: null, user: null },
			});

			const record = await listeningTestsService.createOne(testData);

			return res.status(201).json({
				success: true,
				message: 'Listening test imported successfully',
				data: record,
			});
		} catch (error: any) {
			return res.status(500).json({
				success: false,
				message: error.message || 'An error occurred during import',
				error: error,
			});
		}
	});

	router.get('/', (_req, res) => res.send('v1 endpoint is up and running!'));
});
