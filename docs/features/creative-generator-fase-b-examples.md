# CreativePlan V1 × V2 — fixture-v2-entre-nos-presente

Mesmo request (seed, produto, persona, contexto e Brand Kit iguais); só muda `plan_schema_version`. Gerado por `apps/creative-generator/scripts/render_plan_examples.py`, sem rede.

## Request

```json
{
  "creative_id": "22222222-2222-4222-8222-222222222222",
  "strategy": "CLEAN_ANGLES",
  "product_mode": "single_product",
  "products": [
    {
      "id": "pipa-menina",
      "name": "Brincar com Meu Pai — Pipa Menina",
      "type": "camiseta infantil",
      "description": "camiseta infantil branca de manga curta, estampa vermelha 'BRINCAR COM MEU PAI' com pai e filha empinando pipa e a frase 'deixa a alegria voar longe.'",
      "referenceImages": [
        "tenant-demo/products/pipa-menina/front.webp"
      ],
      "semantic_context": {
        "wearer_roles": [
          "child"
        ],
        "relationship_themes": [
          "father_child"
        ],
        "recommended_supporting_roles": [
          "father"
        ],
        "incompatible_auto_supporting_roles": [
          "mother"
        ],
        "scene_intents": [
          "play",
          "bond",
          "family"
        ],
        "visible_text": [
          "BRINCAR COM MEU PAI",
          "deixa a alegria voar longe."
        ],
        "source": "manual"
      }
    }
  ],
  "brand_kit": {
    "id": "entre_nos_ab",
    "name": "Entre Nós",
    "schemaVersion": 1,
    "version": 1,
    "positioning": [
      "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
    ],
    "visualStyle": [
      "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
      "luz natural quente e suave, hora dourada ou luz de janela",
      "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
    ],
    "colors": [
      "creme e bege quente",
      "bordô/vinho profundo",
      "marrom terroso",
      "navy",
      "off-white"
    ],
    "manualNotes": [
      "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
      "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
      "Crianças em cena sempre à vontade e em interação real com o adulto."
    ],
    "avoid": [
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso"
    ],
    "suggestedPersonas": [
      {
        "label": "menina 6 anos",
        "source": "automatic"
      },
      {
        "label": "mulher 35 anos, mãe da menina",
        "source": "automatic"
      }
    ],
    "minorWardrobePolicy": {
      "enabled": true,
      "legs_coverage": "full",
      "allow_short_shorts": false,
      "allow_short_skirts": false,
      "allow_revealing_clothing": false,
      "style": "casual_age_appropriate"
    }
  },
  "niche_kit_id": "fashion",
  "angle_id": "PRESENTE_AFETO",
  "placement_id": "FEED_4X5",
  "persona_mode": "custom",
  "persona": {
    "label": "menina 6 anos"
  },
  "context": {
    "mode": "custom",
    "profile": {
      "contextId": "entre_nos_sala",
      "contextType": "custom",
      "subject": {
        "name": "Sala de estar acolhedora"
      },
      "summary": "Rotina dentro de casa",
      "sceneContexts": [
        "sala de estar acolhedora com sofá, manta e luz natural lateral"
      ],
      "domainElements": [
        "manta de tricô jogada no encosto"
      ],
      "avoid": [
        "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado"
      ],
      "status": "approved",
      "schemaVersion": 1,
      "promptVersion": 1,
      "profileVersion": 1
    }
  },
  "quality": "medium",
  "seed": 100,
  "plan_schema_version": 2,
  "prompt_version": 2
}
```

## CreativePlan V1 (`plan_schema_version=1`, `prompt_version=1`)

```json
{
  "plan_id": "plan_509a91badb3ab64bf9be66fc",
  "creative_id": "22222222-2222-4222-8222-222222222222",
  "schema_version": 1,
  "strategy": "CLEAN_ANGLES",
  "internal_strategy_id": "ANGULOS_LIMPOS",
  "product_mode": "single_product",
  "products": [
    {
      "id": "pipa-menina",
      "name": "Brincar com Meu Pai — Pipa Menina",
      "type": "camiseta infantil",
      "description": "camiseta infantil branca de manga curta, estampa vermelha 'BRINCAR COM MEU PAI' com pai e filha empinando pipa e a frase 'deixa a alegria voar longe.'",
      "referenceImages": [
        "tenant-demo/products/pipa-menina/front.webp"
      ],
      "semantic_context": {
        "wearer_roles": [
          "child"
        ],
        "relationship_themes": [
          "father_child"
        ],
        "recommended_supporting_roles": [
          "father"
        ],
        "incompatible_auto_supporting_roles": [
          "mother"
        ],
        "scene_intents": [
          "play",
          "bond",
          "family"
        ],
        "visible_text": [
          "BRINCAR COM MEU PAI",
          "deixa a alegria voar longe."
        ],
        "source": "manual"
      }
    }
  ],
  "angle": {
    "id": "PRESENTE_AFETO",
    "label": "Presente / Afeto",
    "description": "Momento de presentear ou uso compartilhado entre duas pessoas — valor emocional.",
    "uses_person": true,
    "apparel_only": false,
    "multi_product_limit": 6
  },
  "placement": {
    "id": "FEED_4X5",
    "label": "Feed (4:5 — 1080×1350)",
    "width": 1080,
    "height": 1350,
    "api_size": "1088x1360"
  },
  "persona": {
    "label": "menina 6 anos",
    "source": "custom"
  },
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral",
    "supporting_element": "manta de tricô jogada no encosto",
    "avoid": [
      "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado",
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso",
      "peça deformada ou com proporção irreal",
      "tecido liso como vetor, sem trama",
      "produto parecendo adesivo colado na foto"
    ],
    "status": "approved",
    "profile_version": 1
  },
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "funnel_stage": null,
  "remarketing_intent": null,
  "layout": null,
  "overlay": {
    "allowed": false,
    "headline": null,
    "subheadline": null,
    "cta": null,
    "badges": [],
    "benefits": [],
    "search_bar_text": null,
    "chips": [],
    "text_density": null,
    "cta_emphasis": null,
    "clean": true
  },
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "references": [
    {
      "ref": "tenant-demo/products/pipa-menina/front.webp",
      "product_id": "pipa-menina",
      "role": "product_art",
      "order": 1
    }
  ],
  "prompt": {
    "text": "<4314 caracteres; ver o CompiledPrompt>",
    "sections": [
      {
        "name": "core_rules",
        "length": 1301
      },
      {
        "name": "strategy_rules",
        "length": 509
      },
      {
        "name": "brand_kit",
        "length": 827
      },
      {
        "name": "niche_kit",
        "length": 301
      },
      {
        "name": "context_profile",
        "length": 223
      },
      {
        "name": "product",
        "length": 278
      },
      {
        "name": "angle",
        "length": 264
      },
      {
        "name": "persona",
        "length": 79
      },
      {
        "name": "placement",
        "length": 39
      },
      {
        "name": "avoid",
        "length": 475
      }
    ],
    "sha256": "3c6246c80e675ff10d6d2b1c9d7c7341403627477b1c3b478747c48a95c3de04",
    "prompt_version": 1
  },
  "model": {
    "task": "image_generation",
    "model": "gpt-image-2",
    "quality": "medium",
    "size": "1088x1360"
  },
  "versions": {
    "core_version": "1.1.0",
    "schema_version": 1,
    "prompt_version": 1,
    "brand_kit_schema_version": 1,
    "niche_kit_schema_version": 1,
    "context_profile_schema_version": 1,
    "clean_angles_version": 1,
    "remarketing_version": 1,
    "funnel_visual_version": 1,
    "strategy_version": 1,
    "brand_kit_version": 1,
    "niche_kit_version": 1,
    "context_profile_version": 1
  },
  "validations": [
    {
      "rule": "product_count_within_limits",
      "passed": true
    },
    {
      "rule": "angle_available_for_brand_and_niche",
      "passed": true
    },
    {
      "rule": "context_profile_approved",
      "passed": true
    },
    {
      "rule": "references_are_product_art_only",
      "passed": true
    },
    {
      "rule": "clean_angles_has_no_overlay",
      "passed": true
    }
  ],
  "warnings": []
}
```

## CreativePlan V2 (`plan_schema_version=2`)

```json
{
  "plan_id": "plan_770a36dde5850037566a7319",
  "creative_id": "22222222-2222-4222-8222-222222222222",
  "schema_version": 2,
  "strategy": "CLEAN_ANGLES",
  "internal_strategy_id": "ANGULOS_LIMPOS",
  "product_mode": "single_product",
  "products": [
    {
      "id": "pipa-menina",
      "name": "Brincar com Meu Pai — Pipa Menina",
      "type": "camiseta infantil",
      "description": "camiseta infantil branca de manga curta, estampa vermelha 'BRINCAR COM MEU PAI' com pai e filha empinando pipa e a frase 'deixa a alegria voar longe.'",
      "referenceImages": [
        "tenant-demo/products/pipa-menina/front.webp"
      ],
      "semantic_context": {
        "wearer_roles": [
          "child"
        ],
        "relationship_themes": [
          "father_child"
        ],
        "recommended_supporting_roles": [
          "father"
        ],
        "incompatible_auto_supporting_roles": [
          "mother"
        ],
        "scene_intents": [
          "play",
          "bond",
          "family"
        ],
        "visible_text": [
          "BRINCAR COM MEU PAI",
          "deixa a alegria voar longe."
        ],
        "source": "manual"
      }
    }
  ],
  "angle": {
    "id": "PRESENTE_AFETO",
    "label": "Presente / Afeto",
    "description": "Momento de presentear ou uso compartilhado entre duas pessoas — valor emocional.",
    "uses_person": true,
    "apparel_only": false,
    "multi_product_limit": 6
  },
  "placement": {
    "id": "FEED_4X5",
    "label": "Feed (4:5 — 1080×1350)",
    "width": 1080,
    "height": 1350,
    "api_size": "1088x1360"
  },
  "persona": {
    "label": "menina 6 anos",
    "source": "custom"
  },
  "context": {
    "context_id": "entre_nos_sala",
    "context_type": "custom",
    "provider": "custom",
    "scene": "sala de estar acolhedora com sofá, manta e luz natural lateral",
    "supporting_element": "manta de tricô jogada no encosto",
    "avoid": [
      "qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado",
      "estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans)",
      "clima de propaganda de margarina",
      "cenário de imobiliária sem sinal de uso",
      "peça deformada ou com proporção irreal",
      "tecido liso como vetor, sem trama",
      "produto parecendo adesivo colado na foto"
    ],
    "status": "approved",
    "profile_version": 1
  },
  "brand_kit": {
    "id": "entre_nos_ab",
    "version": 1
  },
  "niche_kit": {
    "id": "fashion",
    "version": 1
  },
  "funnel_stage": null,
  "remarketing_intent": null,
  "layout": null,
  "overlay": {
    "allowed": false,
    "headline": null,
    "subheadline": null,
    "cta": null,
    "badges": [],
    "benefits": [],
    "search_bar_text": null,
    "chips": [],
    "text_density": null,
    "cta_emphasis": null,
    "clean": true
  },
  "copy": {
    "generate": false,
    "funnel_stages": [
      "TOFU",
      "MOFU",
      "BOFU"
    ]
  },
  "references": [
    {
      "ref": "tenant-demo/products/pipa-menina/front.webp",
      "product_id": "pipa-menina",
      "role": "product_art",
      "order": 1
    }
  ],
  "prompt": {
    "text": "<6566 caracteres; ver o CompiledPrompt>",
    "sections": [
      {
        "name": "fidelity_rules",
        "length": 1302,
        "source": "product",
        "value": "8"
      },
      {
        "name": "text_rules",
        "length": 509,
        "source": "user",
        "value": "clean_creative"
      },
      {
        "name": "minor_safety",
        "length": 474,
        "source": "safety_policy",
        "value": "minors:s1"
      },
      {
        "name": "reference_roles",
        "length": 278,
        "source": "product",
        "value": "refs:1"
      },
      {
        "name": "product_semantic_context",
        "length": 419,
        "source": "product",
        "value": "father_child"
      },
      {
        "name": "people_composition_contract",
        "length": 457,
        "source": "user",
        "value": "2"
      },
      {
        "name": "gaze",
        "length": 85,
        "source": "angle",
        "value": "interaction"
      },
      {
        "name": "scene_action",
        "length": 878,
        "source": "angle",
        "value": "PRESENTE_AFETO"
      },
      {
        "name": "minor_wardrobe_policy",
        "length": 273,
        "source": "brand",
        "value": "full"
      },
      {
        "name": "brand",
        "length": 827,
        "source": "brand",
        "value": "Entre Nós"
      },
      {
        "name": "niche",
        "length": 301,
        "source": "niche",
        "value": "Moda / Vestuário"
      },
      {
        "name": "context",
        "length": 223,
        "source": "user",
        "value": "entre_nos_sala"
      },
      {
        "name": "avoid",
        "length": 475,
        "source": "brand",
        "value": "7"
      },
      {
        "name": "output_format",
        "length": 39,
        "source": "user",
        "value": "FEED_4X5"
      }
    ],
    "sha256": "a79365fa3575569df49ba07fced556503f543afaab1afc033add6bf3fa486d47",
    "prompt_version": 2
  },
  "model": {
    "task": "image_generation",
    "model": "gpt-image-2",
    "quality": "medium",
    "size": "1088x1360"
  },
  "mode": "creative",
  "objective": "clean_creative",
  "subjects": [
    {
      "id": "s1",
      "role": "primary",
      "label": "menina 6 anos",
      "persona": {
        "label": "menina 6 anos",
        "source": "custom"
      },
      "age_band": "child",
      "is_minor": true,
      "minor_source": "persona.label",
      "product_use": "wears",
      "product_id": "pipa-menina",
      "role_hint": null,
      "relation_to_primary": null,
      "prominence": "hero",
      "source": "user"
    },
    {
      "id": "s2",
      "role": "supporting",
      "label": "homem adulto, pai da criança",
      "persona": {
        "label": "homem adulto, pai da criança",
        "source": "automatic"
      },
      "age_band": "adult",
      "is_minor": false,
      "minor_source": null,
      "product_use": "none",
      "product_id": null,
      "role_hint": "father",
      "relation_to_primary": null,
      "prominence": "secondary",
      "source": "planner_default"
    }
  ],
  "scene": {
    "gaze": {
      "mode": "interaction",
      "requested": "auto",
      "source": "angle",
      "reason": "angle_default:PRESENTE_AFETO:multi"
    },
    "picks": {
      "cena": {
        "index": 1,
        "text": "Cena: Pessoa A VESTE {produto}; Pessoa B NÃO veste a peça e usa roupa lisa e neutra, sem estampa. Ação principal: as duas convivem de forma natural, lado a lado, numa conversa leve. Mãos: as de A ficam relaxadas ao lado do corpo; as de B relaxadas ou apoiadas numa superfície do ambiente; nenhuma das duas segura o produto e nenhuma mão cruza o corpo da outra pessoa. Expressão calorosa e contato visual entre A e B."
      }
    },
    "prompt_version": 2,
    "interaction": null
  },
  "composition": {
    "people_count": 2,
    "pose_risk": "low",
    "risk_reasons": [
      "people:2"
    ]
  },
  "minor_safety": {
    "applies": true,
    "minor_subject_ids": [
      "s1"
    ],
    "global": {
      "policy": "global_minor_safety_policy",
      "version": 1,
      "rules": [
        "age_appropriate_clothing",
        "nothing_revealing",
        "not_sexualized",
        "no_adult_aesthetic",
        "age_appropriate_poses",
        "normal_fit_no_body_focus",
        "commercial_family_context"
      ],
      "adult_child_rule": "adult_child_contact_family_only"
    },
    "brand": {
      "policy": "brand_minor_wardrobe_policy",
      "source": "brand",
      "requested": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "effective": {
        "enabled": true,
        "legs_coverage": "full",
        "allow_short_shorts": false,
        "allow_short_skirts": false,
        "allow_revealing_clothing": false,
        "style": "casual_age_appropriate"
      },
      "ignored": []
    }
  },
  "semantics": {
    "products": [
      {
        "product_id": "pipa-menina",
        "semantic_context": {
          "wearer_roles": [
            "child"
          ],
          "relationship_themes": [
            "father_child"
          ],
          "recommended_supporting_roles": [
            "father"
          ],
          "incompatible_auto_supporting_roles": [
            "mother"
          ],
          "scene_intents": [
            "play",
            "bond",
            "family"
          ],
          "visible_text": [
            "BRINCAR COM MEU PAI",
            "deixa a alegria voar longe."
          ],
          "source": "manual"
        }
      }
    ],
    "supporting": {
      "role": "father",
      "source": "product",
      "matched_role": "father"
    },
    "warnings": []
  },
  "resolved_inputs": {
    "brand": {
      "name": "Entre Nós",
      "positioning": [
        "camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa"
      ],
      "visualStyle": [
        "editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo",
        "luz natural quente e suave, hora dourada ou luz de janela",
        "materiais tácteis e domésticos: tecidos, madeira, linho, papel"
      ],
      "colors": [
        "creme e bege quente",
        "bordô/vinho profundo",
        "marrom terroso",
        "navy",
        "off-white"
      ],
      "manualNotes": [
        "Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.",
        "Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.",
        "Crianças em cena sempre à vontade e em interação real com o adulto."
      ]
    },
    "niche": {
      "name": "Moda / Vestuário",
      "materials": [
        "algodão",
        "trama de tecido visível",
        "costuras e acabamento",
        "etiqueta discreta"
      ],
      "audienceBehaviors": [
        "compra pelo caimento e pelo estilo, não só pela estampa",
        "quer ver a peça vestida em corpo real",
        "compara tecido, acabamento e tamanho antes de decidir"
      ]
    },
    "strategy": {
      "text_rule": "MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.",
      "communication": ""
    }
  },
  "provenance": {
    "angle": "user",
    "brand_kit": "user",
    "compiler": "planner_default",
    "composition": "planner_default",
    "context": "user",
    "minor_safety.brand": "brand",
    "minor_safety.global": "safety_policy",
    "mode": "planner_default",
    "model": "planner_default",
    "niche_kit": "user",
    "objective": "user",
    "persona": "user",
    "placement": "user",
    "products": "user",
    "quality": "user",
    "references": "product",
    "resolved_inputs": "brand",
    "scene.gaze": "angle",
    "scene.picks": "planner_default",
    "scene.prompt_version": "planner_default",
    "semantics": "product",
    "strategy": "user",
    "subjects": "user",
    "subjects.supporting": "product"
  },
  "seed": 100,
  "compiler": {
    "version": 1,
    "sections": [
      {
        "section": "fidelity_rules",
        "source": "product",
        "value": "8",
        "length": 1302
      },
      {
        "section": "text_rules",
        "source": "user",
        "value": "clean_creative",
        "length": 509
      },
      {
        "section": "minor_safety",
        "source": "safety_policy",
        "value": "minors:s1",
        "length": 474
      },
      {
        "section": "reference_roles",
        "source": "product",
        "value": "refs:1",
        "length": 278
      },
      {
        "section": "product_semantic_context",
        "source": "product",
        "value": "father_child",
        "length": 419
      },
      {
        "section": "people_composition_contract",
        "source": "user",
        "value": "2",
        "length": 457
      },
      {
        "section": "gaze",
        "source": "angle",
        "value": "interaction",
        "length": 85
      },
      {
        "section": "scene_action",
        "source": "angle",
        "value": "PRESENTE_AFETO",
        "length": 878
      },
      {
        "section": "minor_wardrobe_policy",
        "source": "brand",
        "value": "full",
        "length": 273
      },
      {
        "section": "brand",
        "source": "brand",
        "value": "Entre Nós",
        "length": 827
      },
      {
        "section": "niche",
        "source": "niche",
        "value": "Moda / Vestuário",
        "length": 301
      },
      {
        "section": "context",
        "source": "user",
        "value": "entre_nos_sala",
        "length": 223
      },
      {
        "section": "avoid",
        "source": "brand",
        "value": "7",
        "length": 475
      },
      {
        "section": "output_format",
        "source": "user",
        "value": "FEED_4X5",
        "length": 39
      }
    ]
  },
  "versions": {
    "core_version": "1.1.0",
    "schema_version": 1,
    "prompt_version": 2,
    "brand_kit_schema_version": 1,
    "niche_kit_schema_version": 1,
    "context_profile_schema_version": 1,
    "clean_angles_version": 1,
    "remarketing_version": 1,
    "funnel_visual_version": 1,
    "strategy_version": 1,
    "compiler_version": 1,
    "brand_kit_version": 1,
    "niche_kit_version": 1,
    "context_profile_version": 1
  },
  "validations": [
    {
      "rule": "product_count_within_limits",
      "passed": true
    },
    {
      "rule": "angle_available_for_brand_and_niche",
      "passed": true
    },
    {
      "rule": "context_profile_approved",
      "passed": true
    },
    {
      "rule": "references_are_product_art_only",
      "passed": true
    },
    {
      "rule": "clean_angles_has_no_overlay",
      "passed": true
    }
  ],
  "warnings": []
}
```

## CompiledPrompt do plano V2

`compiler_version=1` · `prompt_version=2` · 6566 caracteres · sha256 `a79365fa3575569df49ba07fced556503f543afaab1afc033add6bf3fa486d47`

### Seções

| # | section | source | value | length |
|---|---|---|---|---|
| 1 | `fidelity_rules` | `product` | `8` | 1302 |
| 2 | `text_rules` | `user` | `clean_creative` | 509 |
| 3 | `minor_safety` | `safety_policy` | `minors:s1` | 474 |
| 4 | `reference_roles` | `product` | `refs:1` | 278 |
| 5 | `product_semantic_context` | `product` | `father_child` | 419 |
| 6 | `people_composition_contract` | `user` | `2` | 457 |
| 7 | `gaze` | `angle` | `interaction` | 85 |
| 8 | `scene_action` | `angle` | `PRESENTE_AFETO` | 878 |
| 9 | `minor_wardrobe_policy` | `brand` | `full` | 273 |
| 10 | `brand` | `brand` | `Entre Nós` | 827 |
| 11 | `niche` | `niche` | `Moda / Vestuário` | 301 |
| 12 | `context` | `user` | `entre_nos_sala` | 223 |
| 13 | `avoid` | `brand` | `7` | 475 |
| 14 | `output_format` | `user` | `FEED_4X5` | 39 |

### Texto completo

```text
REGRAS OBRIGATÓRIAS (nunca ignore):
- Preserve 100% o(s) produto(s) das imagens de referência — forma, cores, materiais, detalhes, estampas e textos originais idênticos; nunca invente, troque, duplique ou funda produtos.
- O produto deve parecer fotografado de verdade na cena: mesma luz, sombra, temperatura de cor e perspectiva do ambiente, textura real do material — nunca recortado ou colado como adesivo.
- Sem logotipos de terceiros, marca d'água, arroba de rede social ou endereço de site.
- Sem urgência falsa ("Só hoje", "Estoque limitado") e sem prova social fabricada (depoimento, nota, estrelas, número de clientes).
- Fotografia realista, alta qualidade, formato vertical.
- Preserve o TIPO DE PEÇA original: camiseta infantil, manga curta, gola redonda, tamanho de criança. Quem VESTE a peça é SEMPRE uma criança, NUNCA um adulto. Elementos culturais de adulto (ex: cuia de mate) NÃO devem ficar nas mãos da criança — podem aparecer só discretamente no cenário ao fundo, se fizer sentido.
- A estampa deve parecer IMPRESSA DE VERDADE no tecido: segue dobras e movimento, recebe a mesma luz e sombra da cena e mostra leve textura da trama por baixo da tinta — nunca lisa como vetor digital.
- Peças dobradas ou penduradas têm VOLUME real de tecido — nunca aparência achatada de recorte 2D.

MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.

PROTEÇÃO DE MENORES (regra absoluta, não negociável): há criança ou adolescente em cena. Sempre: roupa apropriada para a idade; nada revelador; nada sexualizado; nenhuma estética adulta (maquiagem, figurino ou pose de adulto); poses naturais e apropriadas à idade; peças com caimento normal, sem foco no corpo; contexto comercial, familiar e cotidiano coerente. Contato físico entre adulto e criança apenas em situação familiar ou cotidiana coerente com a relação declarada.

PRODUTO (autoridade absoluta sobre qualquer outra regra): imagem 1 = "Brincar com Meu Pai — Pipa Menina" (camiseta infantil) — camiseta infantil branca de manga curta, estampa vermelha 'BRINCAR COM MEU PAI' com pai e filha empinando pipa e a frase 'deixa a alegria voar longe.'.

SEMÂNTICA DO PRODUTO (o significado da estampa orienta o clima da cena; não altera a pose, o enquadramento nem a quantidade de pessoas definidos abaixo):
  · "Brincar com Meu Pai — Pipa Menina" (camiseta infantil) — tema: pai e filho(a); quem veste: criança; a cena pode remeter a: brincar, vínculo, família; pessoa de apoio recomendada: pai; texto visível na peça: "BRINCAR COM MEU PAI"; "deixa a alegria voar longe.".

COMPOSIÇÃO DE PESSOAS (contrato): exatamente 2 pessoas em quadro.
  · Pessoa A (principal): menina 6 anos — veste "Brincar com Meu Pai — Pipa Menina" (camiseta infantil).
  · Pessoa B (apoio): homem adulto, pai da criança — não usa o produto.

PESSOAS (os papéis de cada uma estão definidos na cena; em qualquer conflito, pose, ação e enquadramento definidos no ângulo SEMPRE vencem):
  · Pessoa A: menina 6 anos.
  · Pessoa B: homem adulto, pai da criança.

OLHAR: as pessoas olham uma para a outra ou para a ação em curso — não para a câmera.

ÂNGULO PRESENTE (valor emocional da peça como presente, sem nenhum texto): EXATAMENTE 2 pessoas em quadro, em sala de estar acolhedora com sofá, manta e luz natural lateral. Pessoa A: menina 6 anos. Pessoa B: homem adulto, pai da criança. Cena: Pessoa A VESTE "Brincar com Meu Pai — Pipa Menina" (camiseta infantil); Pessoa B NÃO veste a peça e usa roupa lisa e neutra, sem estampa. Ação principal: as duas convivem de forma natural, lado a lado, numa conversa leve. Mãos: as de A ficam relaxadas ao lado do corpo; as de B relaxadas ou apoiadas numa superfície do ambiente; nenhuma das duas segura o produto e nenhuma mão cruza o corpo da outra pessoa. Expressão calorosa e contato visual entre A e B. Afeto genuíno e contido: gesto real, olhar natural, nenhum sorriso escancarado de banco de imagem, ninguém posando em fileira olhando para a câmera. Produto claramente visível.

VESTUÁRIO DAS CRIANÇAS (política da marca): pernas totalmente cobertas — preferir calça, jeans, sarja, legging apropriada ou peças compridas; nenhuma composição que exponha demais as pernas; sem shorts curtos; sem saias curtas; roupas casuais infantis, apropriadas à idade.

MARCA (Entre Nós):
  · Posicionamento: camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa.
  · Linguagem visual: editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo, luz natural quente e suave, hora dourada ou luz de janela, materiais tácteis e domésticos: tecidos, madeira, linho, papel.
  · Paleta da marca (guia de cor da CENA, nunca do produto): creme e bege quente; bordô/vinho profundo; marrom terroso; navy; off-white.
  · Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.
  · Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.
  · Crianças em cena sempre à vontade e em interação real com o adulto.

NICHO (Moda / Vestuário):
  · Materiais e sinais de uso real: algodão, trama de tecido visível, costuras e acabamento, etiqueta discreta.
  · Público: compra pelo caimento e pelo estilo, não só pela estampa; quer ver a peça vestida em corpo real; compara tecido, acabamento e tamanho antes de decidir.

CONTEXTO DA CENA: sala de estar acolhedora com sofá, manta e luz natural lateral. Elemento de apoio, discreto: manta de tricô jogada no encosto. Contexto coerente e contemporâneo, sem caricatura nem cenário turístico óbvio.

EVITAR (não incluir na cena, mesmo que outra regra sugira algo parecido): qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado; estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans); clima de propaganda de margarina; cenário de imobiliária sem sinal de uso; peça deformada ou com proporção irreal; tecido liso como vetor, sem trama; produto parecendo adesivo colado na foto.

FORMATO: Feed 4:5 vertical (1080×1350).
```

### Como o V1 escreveria o mesmo request (para comparação)

Plano V1 com o texto de cena V2 (`plan_schema_version=1`, `prompt_version=2`): 5065 caracteres, sha256 `d7448fd9529d9fa2…`; plano V1 puro: 4314 caracteres, sha256 `3c6246c80e675ff1…`.

```text
REGRAS OBRIGATÓRIAS (nunca ignore):
- Preserve 100% o(s) produto(s) das imagens de referência — forma, cores, materiais, detalhes, estampas e textos originais idênticos; nunca invente, troque, duplique ou funda produtos.
- O produto deve parecer fotografado de verdade na cena: mesma luz, sombra, temperatura de cor e perspectiva do ambiente, textura real do material — nunca recortado ou colado como adesivo.
- Sem logotipos de terceiros, marca d'água, arroba de rede social ou endereço de site.
- Sem urgência falsa ("Só hoje", "Estoque limitado") e sem prova social fabricada (depoimento, nota, estrelas, número de clientes).
- Fotografia realista, alta qualidade, formato vertical.
- Preserve o TIPO DE PEÇA original: camiseta infantil, manga curta, gola redonda, tamanho de criança. O MODELO da cena é SEMPRE uma criança, NUNCA um adulto. Elementos culturais de adulto (ex: cuia de mate) NÃO devem ficar nas mãos da criança — podem aparecer só discretamente no cenário ao fundo, se fizer sentido.
- A estampa deve parecer IMPRESSA DE VERDADE no tecido: segue dobras e movimento, recebe a mesma luz e sombra da cena e mostra leve textura da trama por baixo da tinta — nunca lisa como vetor digital.
- Peças dobradas ou penduradas têm VOLUME real de tecido — nunca aparência achatada de recorte 2D.

MODO ÂNGULOS LIMPOS (regra absoluta, prioridade máxima): imagem SEM qualquer texto gráfico sobreposto — nada de headline, subheadline, CTA, botão, badge, selo, preço, oferta, desconto, cupom, benefício, ícone de frete, frase promocional ou texto simulando postagem/depoimento/avaliação. O ÚNICO texto permitido na imagem é o que já existe no próprio produto das referências. Não invente nem complemente texto. A imagem representa só um ângulo criativo e deve servir igualmente para copy de TOFU, MOFU ou BOFU.

MARCA (Entre Nós):
  · Posicionamento: camisetas para celebrar quem faz parte de você; o produto não é a estampa, é o laço que ela representa.
  · Linguagem visual: editorial afetivo de marca contemporânea, não catálogo de fast fashion nem banco de imagem corporativo, luz natural quente e suave, hora dourada ou luz de janela, materiais tácteis e domésticos: tecidos, madeira, linho, papel.
  · Paleta da marca (guia de cor da CENA, nunca do produto): creme e bege quente; bordô/vinho profundo; marrom terroso; navy; off-white.
  · Afeto genuíno e contido: gestos reais, nunca sorriso escancarado de banco de imagem, nunca todos olhando para a câmera em fileira.
  · Ambiente doméstico e vivido, com sinal de uso real; nunca cenário de imobiliária vazio.
  · Crianças em cena sempre à vontade e em interação real com o adulto.

NICHO (Moda / Vestuário):
  · Materiais e sinais de uso real: algodão, trama de tecido visível, costuras e acabamento, etiqueta discreta.
  · Público: compra pelo caimento e pelo estilo, não só pela estampa; quer ver a peça vestida em corpo real; compara tecido, acabamento e tamanho antes de decidir.

CONTEXTO DA CENA: sala de estar acolhedora com sofá, manta e luz natural lateral. Elemento de apoio, discreto: manta de tricô jogada no encosto. Contexto coerente e contemporâneo, sem caricatura nem cenário turístico óbvio.

PRODUTO (autoridade absoluta sobre qualquer outra regra): imagem 1 = "Brincar com Meu Pai — Pipa Menina" (camiseta infantil) — camiseta infantil branca de manga curta, estampa vermelha 'BRINCAR COM MEU PAI' com pai e filha empinando pipa e a frase 'deixa a alegria voar longe.'.

ÂNGULO PRESENTE: duas pessoas num momento de presentear "Brincar com Meu Pai — Pipa Menina" (camiseta infantil) (sala de estar acolhedora com sofá, manta e luz natural lateral). menina 6 anos entrega ou recebe o produto; emoção genuína, produto claramente visível.

PERSONA: menina 6 anos. Aparência natural, sem rosto padrão de banco de imagem.

FORMATO: Feed 4:5 vertical (1080×1350).

EVITAR (não incluir na cena, mesmo que outra regra sugira algo parecido): qualquer paisagem regional reconhecível, bandeira, mapa ou elemento cultural típico de um estado; estética de estúdio fotográfico de shopping (fundo infinito colorido, pose simétrica, todos de branco e jeans); clima de propaganda de margarina; cenário de imobiliária sem sinal de uso; peça deformada ou com proporção irreal; tecido liso como vetor, sem trama; produto parecendo adesivo colado na foto.
```
