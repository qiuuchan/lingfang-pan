/**
 * 诊断 image.edit 上游 400 错误。
 * 用法：在桌面端 DevTools Console 里粘贴运行，或在终端 `node scripts/test-image-edit.mjs <token>`
 *
 * 会发一个最小 image.edit 请求到 relay，打印完整的错误 details（含上游真实拒绝原因）。
 */

const BASE = "https://lingfang.guiyuanzi.com";

// 1x1 红色 PNG（最小合法图片）
const TINY_PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

async function main() {
	// 从参数或环境取 token
	const token = process.argv[2] || process.env.LF_TOKEN;
	if (!token) {
		console.log("用法: node scripts/test-image-edit.mjs <jwt-token>");
		console.log(
			"或在桌面端 DevTools Console 运行（自动取 localStorage token）",
		);
		return;
	}

	console.log("=== 测试 image.edit (multipart 透传) ===\n");

	// 构建 multipart body（模拟桥的行为）
	const boundary = "lfTestBoundary" + Date.now();
	const parts = [
		`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\ntest prompt\r\n`,
		`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`,
	];
	const imgBuf = Buffer.from(TINY_PNG_B64, "base64");
	const closing = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n1\r\n--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1024x1024\r\n--${boundary}--\r\n`;

	const body = Buffer.concat([
		Buffer.from(parts[0], "utf8"),
		Buffer.from(parts[1], "utf8"),
		imgBuf,
		Buffer.from(closing, "utf8"),
	]);

	const url = `${BASE}/api/relay/v1/images/edits?model=fast`;
	console.log(`POST ${url}`);
	console.log(`Content-Type: multipart/form-data; boundary=${boundary}`);
	console.log(`Body size: ${body.length} bytes\n`);

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			Authorization: `Bearer ${token}`,
			"X-Client": "desktop",
		},
		body,
	});

	const text = await res.text();
	console.log(`HTTP ${res.status}`);
	console.log(`Response:\n${text}\n`);

	try {
		const json = JSON.parse(text);
		if (json.details) {
			console.log("=== 上游真实错误 ===");
			console.log(`upstreamStatus: ${json.details.upstreamStatus}`);
			console.log(`upstreamDetail: ${json.details.upstreamDetail}`);
		}
		if (json.code) console.log(`\nerrorCode: ${json.code}`);
		if (json.message) console.log(`message: ${json.message}`);
	} catch {
		/* non-JSON */
	}

	// 也测试 images/generations（JSON，非 multipart）
	console.log("\n\n=== 测试 images/generations (JSON) ===\n");
	const genUrl = `${BASE}/api/relay/v1/images/generations`;
	console.log(`POST ${genUrl}`);
	const genRes = await fetch(genUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			"X-Client": "desktop",
		},
		body: JSON.stringify({
			model: "fast",
			prompt: "a red dot",
			n: 1,
			size: "1024x1024",
		}),
	});
	const genText = await genRes.text();
	console.log(`HTTP ${genRes.status}`);
	console.log(`Response:\n${genText}\n`);
	try {
		const json = JSON.parse(genText);
		if (json.details) {
			console.log("=== 上游真实错误 ===");
			console.log(`upstreamStatus: ${json.details.upstreamStatus}`);
			console.log(`upstreamDetail: ${json.details.upstreamDetail}`);
		}
	} catch {
		/* non-JSON */
	}
}

main().catch(console.error);
