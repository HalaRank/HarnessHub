import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Select } from "../src/renderer/Select";

test("select keeps empty values and disabled options in the native control", () => {
  const html = renderToStaticMarkup(
    <Select aria-label="项目" value="" onChange={() => {}}>
      <option value="project">HarnessHub</option>
      <option value="">独立会话</option>
      <option value="missing" disabled>
        不可用项目
      </option>
    </Select>,
  );
  expect(html).toContain('<select aria-label="项目">');
  expect(html).toContain('<option value="" selected="">独立会话</option>');
  expect(html).toContain('<option value="missing" disabled="">不可用项目</option>');
  expect(html).toContain('<selectedcontent class="select-value"></selectedcontent>');
  expect(html).toContain('<button type="button">');
});

test("select forwards form attributes and controlled selection", () => {
  const html = renderToStaticMarkup(
    <Select id="branch" name="branch" value="feature/ui" title="完整分支名" disabled required>
      <option value="main">main</option>
      <option value="feature/ui">feature/ui</option>
    </Select>,
  );
  expect(html).toContain('id="branch" name="branch"');
  expect(html).toContain('title="完整分支名" disabled="" required=""');
  expect(html).toContain('<option value="feature/ui" selected="">feature/ui</option>');
});
